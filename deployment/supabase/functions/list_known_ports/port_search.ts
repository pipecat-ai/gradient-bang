import type {
  MapKnowledge,
  MapKnowledgeEntry,
} from "../_shared/map.ts";

// ── Constants ──────────────────────────────────────────────────────────

export const MAX_HOPS_DEFAULT = 5;
export const MAX_HOPS_LIMIT = 100;

export const COMMODITY_MAP: Record<string, number> = {
  quantum_foam: 0,
  retro_organics: 1,
  neuro_symbolics: 2,
};

export const BASE_PRICES: Record<string, number> = {
  quantum_foam: 25,
  retro_organics: 10,
  neuro_symbolics: 40,
};

export const SELL_MIN = 0.75;
export const SELL_MAX = 1.1;
export const BUY_MIN = 0.9;
export const BUY_MAX = 1.3;

// ── Types ──────────────────────────────────────────────────────────────

export type PortRow = {
  sector_id: number;
  port_code: string;
  port_class: number;
  max_qf: number;
  max_ro: number;
  max_ns: number;
  stock_qf: number;
  stock_ro: number;
  stock_ns: number;
  last_updated: string | null;
};

export type PortResult = {
  sector: {
    id: number;
    position: [number, number];
    port: Record<string, unknown>;
  };
  updated_at: string | null;
  hops_from_start: number;
  last_visited?: string;
};

export type PortFilters = {
  portTypeFilter: string | null;
  commodityFilter: string | null;
  tradeTypeFilter: string | null;
  megaFilter: boolean | null;
};

export type SearchPortsParams = {
  fromSector: number;
  maxHops: number;
  filters: PortFilters;
  portMap: Map<number, PortRow>;
  adjacencyMap: Map<number, number[]>;
  knowledge: MapKnowledge;
  megaPortSectors: Set<number>;
  shipCurrentSector: number | null;
  shipInHyperspace: boolean;
  rpcTimestamp: string;
};

export type SearchPortsResult = {
  results: PortResult[];
  sectorsSearched: number;
};

// ── Pure functions ─────────────────────────────────────────────────────

/**
 * Calculate price when port sells TO player.
 * Price is LOW when stock is high (abundant), HIGH when stock is low (scarce).
 */
export function calculatePriceSellToPlayer(
  commodity: string,
  stock: number,
  maxCapacity: number,
): number {
  if (maxCapacity <= 0) return 0;
  const fullness = stock / maxCapacity;
  const scarcity = 1 - fullness;
  const priceMultiplier =
    SELL_MIN + (SELL_MAX - SELL_MIN) * Math.sqrt(scarcity);
  return Math.round(BASE_PRICES[commodity] * priceMultiplier);
}

/**
 * Calculate price when port buys FROM player.
 * Price is HIGH when stock is low (needs more), LOW when stock is high (saturated).
 */
export function calculatePriceBuyFromPlayer(
  commodity: string,
  stock: number,
  maxCapacity: number,
): number {
  if (maxCapacity <= 0) return 0;
  const fullness = stock / maxCapacity;
  const need = 1 - fullness;
  const priceMultiplier = BUY_MIN + (BUY_MAX - BUY_MIN) * Math.sqrt(need);
  return Math.round(BASE_PRICES[commodity] * priceMultiplier);
}

/**
 * Decode port_code to determine what commodities are bought/sold.
 * Format: BBB = all buy, SSS = all sell, BSS = buy QF, sell RO/NS, etc.
 * Position 0 = quantum_foam, 1 = retro_organics, 2 = neuro_symbolics
 */
export function decodePortCode(
  portCode: string,
): { buys: string[]; sells: string[] } {
  const commodities = ["quantum_foam", "retro_organics", "neuro_symbolics"];
  const buys: string[] = [];
  const sells: string[] = [];

  for (let i = 0; i < 3 && i < portCode.length; i++) {
    if (portCode[i] === "B" || portCode[i] === "b") {
      buys.push(commodities[i]);
    } else if (portCode[i] === "S" || portCode[i] === "s") {
      sells.push(commodities[i]);
    }
  }

  return { buys, sells };
}

/**
 * Calculate trading prices for all commodities at a port.
 * Returns prices object with null for commodities not traded.
 */
export function getPortPrices(
  portCode: string,
  stockQf: number,
  stockRo: number,
  stockNs: number,
  maxQf: number,
  maxRo: number,
  maxNs: number,
): Record<string, number | null> {
  const { buys, sells } = decodePortCode(portCode);
  const stocks: Record<string, number> = {
    quantum_foam: stockQf,
    retro_organics: stockRo,
    neuro_symbolics: stockNs,
  };
  const maxes: Record<string, number> = {
    quantum_foam: maxQf,
    retro_organics: maxRo,
    neuro_symbolics: maxNs,
  };

  const prices: Record<string, number | null> = {
    quantum_foam: null,
    retro_organics: null,
    neuro_symbolics: null,
  };

  for (const commodity of [
    "quantum_foam",
    "retro_organics",
    "neuro_symbolics",
  ]) {
    const stock = stocks[commodity];
    const maxCap = maxes[commodity];

    if (sells.includes(commodity) && maxCap > 0) {
      prices[commodity] = calculatePriceSellToPlayer(commodity, stock, maxCap);
    } else if (buys.includes(commodity) && maxCap > 0 && stock < maxCap) {
      prices[commodity] = calculatePriceBuyFromPlayer(commodity, stock, maxCap);
    }
  }

  return prices;
}

export function portMatchesFilters(
  portRow: PortRow,
  portTypeFilter: string | null,
  commodity: string | null,
  tradeType: string | null,
  megaFilter: boolean | null,
  isMega: boolean,
): boolean {
  const code = portRow.port_code?.toUpperCase() ?? "";
  if (portTypeFilter && code !== portTypeFilter) {
    return false;
  }
  if (megaFilter !== null && megaFilter !== isMega) {
    return false;
  }
  if (commodity && tradeType) {
    const index = COMMODITY_MAP[commodity];
    if (typeof index !== "number") {
      return false;
    }
    const codeChar = code.charAt(index);
    if (tradeType === "buy") {
      return codeChar === "S";
    }
    return codeChar === "B";
  }
  return true;
}

export function buildPortResult(
  node: { sector: number; hops: number },
  hops: number,
  portRow: PortRow,
  knowledgeEntry:
    | { position?: [number, number]; last_visited?: string }
    | undefined,
  inSector: boolean,
  rpcTimestamp: string,
  isMega: boolean,
): PortResult {
  const position = knowledgeEntry?.position ?? [0, 0];

  const prices = getPortPrices(
    portRow.port_code,
    portRow.stock_qf,
    portRow.stock_ro,
    portRow.stock_ns,
    portRow.max_qf,
    portRow.max_ro,
    portRow.max_ns,
  );

  const portPayload = {
    code: portRow.port_code,
    mega: isMega,
    stock: {
      quantum_foam: portRow.stock_qf,
      retro_organics: portRow.stock_ro,
      neuro_symbolics: portRow.stock_ns,
    },
    prices,
    observed_at: inSector ? null : portRow.last_updated,
  } as Record<string, unknown>;

  return {
    sector: {
      id: node.sector,
      position,
      port: portPayload,
    },
    updated_at: portRow.last_updated,
    hops_from_start: hops,
    last_visited: knowledgeEntry?.last_visited,
  };
}

// ── BFS search ─────────────────────────────────────────────────────────

/**
 * Pure synchronous BFS over pre-loaded data. No DB calls.
 */
export function searchPorts(params: SearchPortsParams): SearchPortsResult {
  const {
    fromSector,
    maxHops,
    filters,
    portMap,
    adjacencyMap,
    knowledge,
    megaPortSectors,
    shipCurrentSector,
    shipInHyperspace,
    rpcTimestamp,
  } = params;

  const { portTypeFilter, commodityFilter, tradeTypeFilter, megaFilter } =
    filters;

  const visitedBfs = new Set<number>([fromSector]);
  const results: PortResult[] = [];
  let sectorsSearched = 0;

  let frontier: number[] = [fromSector];
  let hops = 0;

  while (frontier.length > 0) {
    const next: number[] = [];
    for (const sectorId of frontier) {
      sectorsSearched += 1;

      const portRow = portMap.get(sectorId);
      if (portRow) {
        const isMega = megaPortSectors.has(sectorId);
        if (
          portMatchesFilters(
            portRow,
            portTypeFilter,
            commodityFilter,
            tradeTypeFilter,
            megaFilter,
            isMega,
          )
        ) {
          const knowledgeEntry = knowledge.sectors_visited[String(sectorId)];
          const inSector =
            shipCurrentSector !== null &&
            shipCurrentSector === sectorId &&
            !shipInHyperspace;
          results.push(
            buildPortResult(
              { sector: sectorId, hops },
              hops,
              portRow,
              knowledgeEntry,
              inSector,
              rpcTimestamp,
              isMega,
            ),
          );
        }
      }

      if (hops >= maxHops) {
        continue;
      }

      const adjacency = adjacencyMap.get(sectorId) ?? [];
      for (const neighbor of adjacency) {
        if (!visitedBfs.has(neighbor)) {
          visitedBfs.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    if (hops >= maxHops) {
      break;
    }
    frontier = next;
    hops += 1;
  }

  results.sort((a, b) => {
    if (a.hops_from_start !== b.hops_from_start) {
      return a.hops_from_start - b.hops_from_start;
    }
    return a.sector.id - b.sector.id;
  });

  return { results, sectorsSearched };
}
