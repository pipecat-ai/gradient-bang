import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

// Fix: Added senderId to trade event emission for corporation ship tracking
import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  commodityKey,
  buildPortData,
  calculatePriceSellToPlayer,
  calculatePriceBuyFromPlayer,
  getPortPrices,
  getPortStock,
  isCommodity,
  loadPortBySector,
  portSupportsTrade,
  TradingValidationError,
  validateBuyTransaction,
  validateSellTransaction,
  type Commodity,
  type PortData,
  type PortRow,
  type TradeType,
} from '../_shared/trading.ts';
import { buildStatusPayload, loadCharacter, loadShip, loadShipDefinition } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

class TradeError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TradeError';
    this.status = status;
  }
}

// Optimistic concurrency control: Retry attempts for port inventory updates
// Legacy uses pessimistic locking (async locks) which queues all requests
// Supabase uses optimistic locking (version checks) which requires retries
//
// For high-concurrency scenarios (50 concurrent trades):
// - Need ~15 attempts for 70% success rate (35/50 trades)
// - Exponential backoff reduces retry collisions
const MAX_PORT_ATTEMPTS = 15;

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('trade.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const rawCharacterId = requireString(payload, 'character_id');
  const characterId = await canonicalizeCharacterId(rawCharacterId);
  const actorCharacterLabel = optionalString(payload, 'actor_character_id');
  const actorCharacterId = actorCharacterLabel ? await canonicalizeCharacterId(actorCharacterLabel) : null;
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  try {
    await enforceRateLimit(supabase, characterId, 'trade');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'trade',
        requestId,
        detail: 'Too many trade requests',
        status: 429,
      });
      return errorResponse('Too many trade requests', 429);
    }
    console.error('trade.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleTrade(supabase, payload, characterId, requestId, adminOverride, actorCharacterId);
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'trade',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof TradeError || err instanceof TradingValidationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'trade',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('trade.unhandled', err);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'trade',
      requestId,
      detail: 'internal server error',
      status: 500,
    });
    return errorResponse('internal server error', 500);
  }
});

async function handleTrade(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  requestId: string,
  adminOverride: boolean,
  actorCharacterId: string | null,
): Promise<Response> {
  const source = buildEventSource('trade', requestId);

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  const shipDefinition = await loadShipDefinition(supabase, ship.ship_type);

  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  if (ship.in_hyperspace) {
    throw new TradeError('Character is in hyperspace, cannot trade', 409);
  }
  const sectorId = ship.current_sector;
  if (sectorId === null || sectorId === undefined) {
    throw new TradeError('Ship sector is unavailable', 500);
  }

  const commodityRaw = requireString(payload, 'commodity');
  const commodity = normalizeCommodityValue(commodityRaw);
  if (!commodity) {
    throw new TradeError(`Invalid commodity: ${commodityRaw}`);
  }

  const tradeTypeRaw = requireString(payload, 'trade_type').toLowerCase();
  if (tradeTypeRaw !== 'buy' && tradeTypeRaw !== 'sell') {
    throw new TradeError("trade_type must be 'buy' or 'sell'");
  }
  const tradeType = tradeTypeRaw as TradeType;

  const quantityValue = optionalNumber(payload, 'quantity');
  if (quantityValue === null) {
    throw new TradeError('quantity is required and must be a number');
  }
  const quantity = Math.floor(quantityValue);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new TradeError('quantity must be a positive integer');
  }

  const portRowInitial = await loadPortBySector(supabase, sectorId);
  if (!portRowInitial) {
    throw new TradeError('No port at current location', 400);
  }

  const shipCredits = ship.credits ?? 0;
  const shipCargo = buildCargoMap(ship);
  const cargoCapacity = shipDefinition.cargo_holds ?? 0;
  const cargoUsed = cargoTotal(shipCargo);

  const execution = await executeTradeWithPortRetry({
    supabase,
    sectorId,
    commodity,
    tradeType,
    quantity,
    shipCredits,
    shipCargo,
    cargoCapacity,
    cargoUsed,
    initialPort: portRowInitial,
  });

  let shipUpdate = supabase
    .from('ship_instances')
    .update({
      credits: execution.computation.updatedCredits,
      cargo_qf: execution.computation.updatedCargo.quantum_foam,
      cargo_ro: execution.computation.updatedCargo.retro_organics,
      cargo_ns: execution.computation.updatedCargo.neuro_symbolics,
    })
    .eq('ship_id', ship.ship_id);
  if (ship.owner_id) {
    shipUpdate = shipUpdate.eq('owner_id', ship.owner_id);
  }
  const shipUpdateResult = await shipUpdate.select('ship_id').maybeSingle();
  if (shipUpdateResult.error || !shipUpdateResult.data) {
    console.error('trade.ship_update', shipUpdateResult.error);
    await revertPortInventory(supabase, execution.originalPort, execution.updatedPort);
    throw new TradeError('failed to update ship after trade', 500);
  }

  const timestamp = execution.observedAt;
  const { error: characterUpdateError } = await supabase
    .from('characters')
    .update({ last_active: timestamp })
    .eq('character_id', characterId);
  if (characterUpdateError) {
    console.error('trade.character_update', characterUpdateError);
  }

  await recordPortTransaction(supabase, {
    sectorId,
    portId: execution.updatedPort.port_id,
    characterId,
    shipId: ship.ship_id,
    commodity,
    tradeType,
    quantity,
    pricePerUnit: execution.computation.pricePerUnit,
    totalPrice: execution.computation.totalPrice,
  });

  const statusPayload = await buildStatusPayload(supabase, characterId);
  const priceMap = getPortPrices(execution.portDataAfter);
  const stockMap = getPortStock(execution.portDataAfter);
  const portUpdatePayload = {
    sector: {
      id: sectorId,
      port: {
        code: execution.updatedPort.port_code,
        prices: priceMap,
        stock: stockMap,
      },
    },
    updated_at: timestamp,
  };

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'trade.executed',
    payload: {
      source,
      player: statusPayload.player,
      ship: statusPayload.ship,
      trade: {
        trade_type: tradeType,
        commodity,
        units: quantity,
        price_per_unit: execution.computation.pricePerUnit,
        total_price: execution.computation.totalPrice,
        new_credits: execution.computation.updatedCredits,
        new_cargo: execution.computation.updatedCargo,
        new_prices: priceMap,
      },
    },
    senderId: characterId,
    sectorId,
    shipId: ship.ship_id,
    requestId,
    actorCharacterId,
    corpId: ship.owner_corporation_id ?? character.corporation_id,
  });

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'status.update',
    payload: statusPayload,
    sectorId,
    shipId: ship.ship_id,
    requestId,
    actorCharacterId,
    corpId: ship.owner_corporation_id ?? character.corporation_id,
  });

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'port.update',
    payload: portUpdatePayload,
    sectorId,
    shipId: ship.ship_id,
    requestId,
    actorCharacterId,
    corpId: ship.owner_corporation_id ?? character.corporation_id,
  });

  await emitPortUpdateEvents(supabase, {
    sectorId,
    recipients: (await listCharactersInSector(supabase, sectorId)).filter((id) => id !== characterId),
    payload: portUpdatePayload,
  });

  return successResponse({ request_id: requestId });
}

function normalizeCommodityValue(value: string): Commodity | null {
  const lowered = value.trim().toLowerCase();
  if (isCommodity(lowered)) {
    return lowered as Commodity;
  }
  return null;
}

function buildCargoMap(ship: { cargo_qf: number | null; cargo_ro: number | null; cargo_ns: number | null }): Record<Commodity, number> {
  return {
    quantum_foam: ship.cargo_qf ?? 0,
    retro_organics: ship.cargo_ro ?? 0,
    neuro_symbolics: ship.cargo_ns ?? 0,
  };
}

function cargoTotal(cargo: Record<Commodity, number>): number {
  return cargo.quantum_foam + cargo.retro_organics + cargo.neuro_symbolics;
}

async function executeTradeWithPortRetry(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  sectorId: number;
  commodity: Commodity;
  tradeType: TradeType;
  quantity: number;
  shipCredits: number;
  shipCargo: Record<Commodity, number>;
  cargoCapacity: number;
  cargoUsed: number;
  initialPort: PortRow;
}): Promise<{
  computation: TradeComputation;
  updatedPort: PortRow;
  originalPort: PortRow;
  observedAt: string;
  portDataAfter: PortData;
}> {
  let attempt = 0;
  let currentPort = params.initialPort;
  console.log(`[trade.retry] Starting trade at sector ${params.sectorId}, port version ${currentPort.version}, commodity ${params.commodity}, quantity ${params.quantity}`);

  while (attempt < MAX_PORT_ATTEMPTS) {
    console.log(`[trade.retry] Attempt ${attempt + 1}/${MAX_PORT_ATTEMPTS}, port version ${currentPort.version}`);

    const computation = computeTradeOutcome({
      portRow: currentPort,
      commodity: params.commodity,
      tradeType: params.tradeType,
      quantity: params.quantity,
      shipCredits: params.shipCredits,
      shipCargo: params.shipCargo,
      cargoCapacity: params.cargoCapacity,
      cargoUsed: params.cargoUsed,
    });

    const observedAt = new Date().toISOString();
    const updateResult = await attemptPortUpdate(params.supabase, currentPort, computation.updatedPortStock, observedAt);
    if (updateResult) {
      console.log(`[trade.retry] SUCCESS on attempt ${attempt + 1}, new version ${updateResult.version}`);
      return {
        computation,
        updatedPort: updateResult,
        originalPort: currentPort,
        observedAt,
        portDataAfter: buildPortData(updateResult),
      };
    }

    console.log(`[trade.retry] Port version mismatch on attempt ${attempt + 1}, refreshing...`);

    // Exponential backoff with jitter to reduce retry collisions
    // Spreads out retries over time instead of all hitting at once
    // Base: 10ms, doubles each attempt, with random jitter (0-100%)
    const baseDelayMs = 10;
    const maxJitterMs = baseDelayMs * Math.pow(2, attempt);
    const jitterMs = Math.random() * maxJitterMs;
    console.log(`[trade.retry] Backing off ${jitterMs.toFixed(1)}ms before retry`);
    await new Promise(resolve => setTimeout(resolve, jitterMs));

    const refreshed = await loadPortBySector(params.supabase, params.sectorId);
    if (!refreshed) {
      throw new TradeError('Port became unavailable', 409);
    }
    console.log(`[trade.retry] Refreshed port, new version ${refreshed.version}`);
    currentPort = refreshed;
    attempt += 1;
  }
  console.error(`[trade.retry] FAILED after ${MAX_PORT_ATTEMPTS} attempts at sector ${params.sectorId}`);
  throw new TradeError('Port inventory changed, please retry', 409);
}

function computeTradeOutcome(params: {
  portRow: PortRow;
  commodity: Commodity;
  tradeType: TradeType;
  quantity: number;
  shipCredits: number;
  shipCargo: Record<Commodity, number>;
  cargoCapacity: number;
  cargoUsed: number;
}): TradeComputation {
  const portData = buildPortData(params.portRow);
  if (!portSupportsTrade(portData, params.commodity, params.tradeType)) {
    throw new TradeError(
      params.tradeType === 'buy'
        ? `Port does not sell ${params.commodity}`
        : `Port does not buy ${params.commodity}`,
      400,
    );
  }

  const commodityKeyValue = commodityKey(params.commodity);
  const currentStock = portData.stock[commodityKeyValue] ?? 0;
  const maxCapacity = portData.max_capacity[commodityKeyValue] ?? 0;
  const cargoClone: Record<Commodity, number> = { ...params.shipCargo };

  let pricePerUnit: number;
  if (params.tradeType === 'buy') {
    pricePerUnit = calculatePriceSellToPlayer(params.commodity, currentStock, maxCapacity);
    validateBuyTransaction(
      params.shipCredits,
      params.cargoUsed,
      params.cargoCapacity,
      params.commodity,
      params.quantity,
      currentStock,
      pricePerUnit,
    );
    portData.stock[commodityKeyValue] = currentStock - params.quantity;
    cargoClone[params.commodity] = (cargoClone[params.commodity] ?? 0) + params.quantity;
  } else {
    pricePerUnit = calculatePriceBuyFromPlayer(params.commodity, currentStock, maxCapacity);
    validateSellTransaction(
      cargoClone,
      params.commodity,
      params.quantity,
      currentStock,
      maxCapacity,
    );
    portData.stock[commodityKeyValue] = currentStock + params.quantity;
    cargoClone[params.commodity] = Math.max(0, (cargoClone[params.commodity] ?? 0) - params.quantity);
  }

  const totalPrice = pricePerUnit * params.quantity;
  const updatedCredits = params.tradeType === 'buy'
    ? params.shipCredits - totalPrice
    : params.shipCredits + totalPrice;

  return {
    updatedCredits,
    updatedCargo: cargoClone,
    pricePerUnit,
    totalPrice,
    updatedPortStock: { ...portData.stock },
  };
}

async function attemptPortUpdate(
  supabase: ReturnType<typeof createServiceRoleClient>,
  portRow: PortRow,
  updatedStock: Record<string, number>,
  observedAt: string,
): Promise<PortRow | null> {
  const { data, error } = await supabase
    .from('ports')
    .update({
      stock_qf: updatedStock['QF'],
      stock_ro: updatedStock['RO'],
      stock_ns: updatedStock['NS'],
      last_updated: observedAt,
      version: portRow.version + 1,
    })
    .eq('port_id', portRow.port_id)
    .eq('version', portRow.version)
    .select(
      'port_id, sector_id, port_code, port_class, max_qf, max_ro, max_ns, stock_qf, stock_ro, stock_ns, version, last_updated',
    )
    .maybeSingle();

  if (error) {
    console.error('trade.port_update', error);
    throw new TradeError('Failed to update port inventory', 500);
  }

  if (!data) {
    return null;
  }
  return data as PortRow;
}

async function revertPortInventory(
  supabase: ReturnType<typeof createServiceRoleClient>,
  previous: PortRow,
  current: PortRow,
): Promise<void> {
  const { error } = await supabase
    .from('ports')
    .update({
      stock_qf: previous.stock_qf,
      stock_ro: previous.stock_ro,
      stock_ns: previous.stock_ns,
      last_updated: new Date().toISOString(),
      version: current.version + 1,
    })
    .eq('port_id', current.port_id)
    .eq('version', current.version);
  if (error) {
    console.error('trade.port_revert', error);
  }
}

async function recordPortTransaction(
  supabase: ReturnType<typeof createServiceRoleClient>,
  params: {
    sectorId: number;
    portId: number;
    characterId: string;
    shipId: string;
    commodity: Commodity;
    tradeType: TradeType;
    quantity: number;
    pricePerUnit: number;
    totalPrice: number;
  },
): Promise<void> {
  const { error } = await supabase
    .from('port_transactions')
    .insert({
      sector_id: params.sectorId,
      port_id: params.portId,
      character_id: params.characterId,
      ship_id: params.shipId,
      commodity: commodityKey(params.commodity),
      quantity: params.quantity,
      transaction_type: params.tradeType,
      price_per_unit: params.pricePerUnit,
      total_price: params.totalPrice,
    });
  if (error) {
    console.error('trade.port_transaction', error);
  }
}

async function listCharactersInSector(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sectorId: number,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('ship_instances')
    .select('ship_id, in_hyperspace')
    .eq('current_sector', sectorId);
  if (error) {
    console.error('trade.list_characters', error);
    return [];
  }
  const shipIds = (data ?? [])
    .filter((row) => row && row.in_hyperspace !== true)
    .map((row) => row.ship_id)
    .filter((shipId): shipId is string => typeof shipId === 'string' && shipId.length > 0);
  if (shipIds.length === 0) {
    return [];
  }
  const { data: characters, error: characterError } = await supabase
    .from('characters')
    .select('character_id, current_ship_id')
    .in('current_ship_id', shipIds);
  if (characterError) {
    console.error('trade.list_characters.characters', characterError);
    return [];
  }
  const ids = new Set<string>();
  for (const row of characters ?? []) {
    if (typeof row.character_id === 'string' && row.character_id.length > 0) {
      ids.add(row.character_id);
    }
  }
  return Array.from(ids);
}

async function emitPortUpdateEvents(
  supabase: ReturnType<typeof createServiceRoleClient>,
  params: {
    sectorId: number;
    recipients: string[];
    payload: Record<string, unknown>;
  },
): Promise<void> {
  if (params.recipients.length === 0) {
    return;
  }

  await Promise.all(
    params.recipients.map((recipient) =>
      emitCharacterEvent({
        supabase,
        characterId: recipient,
        eventType: 'port.update',
        payload: params.payload,
        sectorId: params.sectorId,
      }),
    ),
  );
}

type TradeComputation = {
  updatedCredits: number;
  updatedCargo: Record<Commodity, number>;
  pricePerUnit: number;
  totalPrice: number;
  updatedPortStock: Record<string, number>;
};
