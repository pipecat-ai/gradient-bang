import type { SupabaseClient } from "@supabase/supabase-js";

export type Commodity = "quantum_foam" | "retro_organics" | "neuro_symbolics";
export type CommodityKey = "QF" | "RO" | "NS";

const COMMODITY_ORDER: Commodity[] = [
  "quantum_foam",
  "retro_organics",
  "neuro_symbolics",
];
const COMMODITY_KEY_MAP: Record<Commodity, CommodityKey> = {
  quantum_foam: "QF",
  retro_organics: "RO",
  neuro_symbolics: "NS",
};

const BASE_PRICES: Record<Commodity, number> = {
  quantum_foam: 25,
  retro_organics: 10,
  neuro_symbolics: 40,
};

const SELL_MIN = 0.75;
const SELL_MAX = 1.1;
const BUY_MIN = 0.9;
const BUY_MAX = 1.3;

export interface PortRow {
  port_id: number;
  sector_id: number;
  port_code: string;
  port_class: number;
  max_qf: number;
  max_ro: number;
  max_ns: number;
  stock_qf: number;
  stock_ro: number;
  stock_ns: number;
  version: number;
  last_updated: string | null;
}

export interface PortData {
  code: string;
  class: number;
  stock: Record<CommodityKey, number>;
  max_capacity: Record<CommodityKey, number>;
  buys: Commodity[];
  sells: Commodity[];
}

export type TradeType = "buy" | "sell";

export function isCommodity(candidate: unknown): candidate is Commodity {
  return (
    typeof candidate === "string" &&
    (COMMODITY_ORDER as string[]).includes(candidate)
  );
}

export function normalizeCommodity(candidate: unknown): Commodity | null {
  if (isCommodity(candidate)) {
    return candidate;
  }
  if (typeof candidate === "string") {
    const lowered = candidate.toLowerCase();
    return isCommodity(lowered) ? (lowered as Commodity) : null;
  }
  return null;
}

export function commodityKey(value: Commodity): CommodityKey {
  return COMMODITY_KEY_MAP[value];
}

export function commodityFromIndex(index: number): Commodity {
  return COMMODITY_ORDER[index] ?? "quantum_foam";
}

export async function loadPortBySector(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<PortRow | null> {
  const { data: contents, error: contentsError } = await supabase
    .from("sector_contents")
    .select("port_id")
    .eq("sector_id", sectorId)
    .maybeSingle();
  if (contentsError) {
    throw new Error(
      `failed to load sector contents for ${sectorId}: ${contentsError.message}`,
    );
  }
  if (!contents?.port_id) {
    return null;
  }

  const { data, error } = await supabase
    .from("ports")
    .select(
      "port_id, sector_id, port_code, port_class, max_qf, max_ro, max_ns, stock_qf, stock_ro, stock_ns, version, last_updated",
    )
    .eq("port_id", contents.port_id)
    .maybeSingle();
  if (error) {
    throw new Error(
      `failed to load port for sector ${sectorId}: ${error.message}`,
    );
  }
  return data as PortRow | null;
}

export function buildPortData(row: PortRow): PortData {
  const buys: Commodity[] = [];
  const sells: Commodity[] = [];
  for (let i = 0; i < COMMODITY_ORDER.length; i += 1) {
    const commodity = commodityFromIndex(i);
    const code = row.port_code?.charAt(i) ?? "S";
    if (code === "B") {
      buys.push(commodity);
    } else {
      sells.push(commodity);
    }
  }
  return {
    code: row.port_code,
    class: row.port_class,
    stock: {
      QF: row.stock_qf,
      RO: row.stock_ro,
      NS: row.stock_ns,
    },
    max_capacity: {
      QF: row.max_qf,
      RO: row.max_ro,
      NS: row.max_ns,
    },
    buys,
    sells,
  };
}

export function portSupportsTrade(
  portData: PortData,
  commodity: Commodity,
  tradeType: TradeType,
): boolean {
  if (tradeType === "buy") {
    return portData.sells.includes(commodity);
  }
  return portData.buys.includes(commodity);
}

export function calculatePriceSellToPlayer(
  commodity: Commodity,
  stock: number,
  maxCapacity: number,
): number {
  if (maxCapacity <= 0) {
    throw new Error("invalid max capacity for sell price calculation");
  }
  const fullness = stock / maxCapacity;
  const scarcity = 1 - fullness;
  const multiplier =
    SELL_MIN +
    (SELL_MAX - SELL_MIN) * Math.sqrt(Math.max(0, Math.min(1, scarcity)));
  return Math.round(BASE_PRICES[commodity] * multiplier);
}

export function calculatePriceBuyFromPlayer(
  commodity: Commodity,
  stock: number,
  maxCapacity: number,
): number {
  if (maxCapacity <= 0) {
    throw new Error("invalid max capacity for buy price calculation");
  }
  const need = 1 - stock / maxCapacity;
  const multiplier =
    BUY_MIN + (BUY_MAX - BUY_MIN) * Math.sqrt(Math.max(0, Math.min(1, need)));
  return Math.round(BASE_PRICES[commodity] * multiplier);
}

export function getPortPrices(
  portData: PortData,
): Record<Commodity, number | null> {
  const prices: Record<Commodity, number | null> = {
    quantum_foam: null,
    retro_organics: null,
    neuro_symbolics: null,
  };
  for (const commodity of COMMODITY_ORDER) {
    const key = commodityKey(commodity);
    const stock = portData.stock[key];
    const maxCapacity = portData.max_capacity[key];
    if (portData.sells.includes(commodity)) {
      prices[commodity] = calculatePriceSellToPlayer(
        commodity,
        stock,
        maxCapacity,
      );
    } else if (portData.buys.includes(commodity) && stock < maxCapacity) {
      prices[commodity] = calculatePriceBuyFromPlayer(
        commodity,
        stock,
        maxCapacity,
      );
    } else {
      prices[commodity] = null;
    }
  }
  return prices;
}

export function getPortStock(portData: PortData): Record<Commodity, number> {
  return {
    quantum_foam: portData.stock.QF ?? 0,
    retro_organics: portData.stock.RO ?? 0,
    neuro_symbolics: portData.stock.NS ?? 0,
  };
}

export class TradingValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TradingValidationError";
    this.status = status;
  }
}

export function validateBuyTransaction(
  playerCredits: number,
  cargoUsed: number,
  cargoCapacity: number,
  commodity: Commodity,
  quantity: number,
  portStock: number,
  pricePerUnit: number,
): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new TradingValidationError("Quantity must be a positive integer");
  }
  if (portStock < quantity) {
    throw new TradingValidationError(
      `Port only has ${portStock} units of ${commodity}`,
    );
  }
  const freeSpace = cargoCapacity - cargoUsed;
  if (freeSpace < quantity) {
    throw new TradingValidationError(
      `Not enough cargo space. Available: ${freeSpace}`,
    );
  }
  const totalPrice = pricePerUnit * quantity;
  if (playerCredits < totalPrice) {
    throw new TradingValidationError(
      `Insufficient credits. Need ${totalPrice}, have ${playerCredits}`,
    );
  }
}

export function validateSellTransaction(
  cargo: Record<Commodity, number>,
  commodity: Commodity,
  quantity: number,
  portStock: number,
  portMaxCapacity: number,
): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new TradingValidationError("Quantity must be a positive integer");
  }
  if ((cargo[commodity] ?? 0) < quantity) {
    throw new TradingValidationError(
      `Not enough ${commodity} to sell. Have ${cargo[commodity] ?? 0}`,
    );
  }
  const availableCapacity = portMaxCapacity - portStock;
  if (availableCapacity < quantity) {
    throw new TradingValidationError(
      `Port can only buy ${availableCapacity} units of ${commodity}`,
    );
  }
}
