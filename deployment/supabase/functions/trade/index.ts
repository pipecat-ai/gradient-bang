import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { createPgClient } from '../_shared/pg.ts';
import {
  pgEnforceRateLimit,
  pgLoadCharacter,
  pgLoadShip,
  pgLoadShipDefinition,
  pgUpdateCharacterLastActive,
  pgBuildStatusPayload,
  pgEmitCharacterEvent,
  pgEnsureActorAuthorization,
  pgLoadPortBySector,
  pgExecuteTradeTransaction,
  pgRecordPortTransaction,
  pgListCharactersInSector,
  ActorAuthorizationError,
  type PortRow,
  type ShipTradeUpdate,
} from '../_shared/pg_queries.ts';
import {
  commodityKey,
  buildPortData,
  calculatePriceSellToPlayer,
  calculatePriceBuyFromPlayer,
  getPortPrices,
  getPortStock,
  isCommodity,
  portSupportsTrade,
  TradingValidationError,
  validateBuyTransaction,
  validateSellTransaction,
  type Commodity,
  type PortData,
  type TradeType,
} from '../_shared/trading.ts';
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
import type { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

class TradeError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TradeError';
    this.status = status;
  }
}

// Optimistic concurrency control: Retry attempts for port inventory updates
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
  const taskId = optionalString(payload, 'task_id');

  // Create PG client for direct database access
  const pgClient = createPgClient();

  // Timing trace
  const trace: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (label: string) => {
    trace[label] = Date.now() - t0;
  };

  try {
    await pgClient.connect();
    mark('pg_connect');

    try {
      await pgEnforceRateLimit(pgClient, characterId, 'trade');
      mark('rate_limit');
    } catch (err) {
      if (err instanceof Error && err.message.includes('rate limit')) {
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

    return await handleTrade({
      pgClient,
      supabase,
      payload,
      characterId,
      requestId,
      adminOverride,
      actorCharacterId,
      taskId,
      trace,
      mark,
    });
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
  } finally {
    trace['total'] = Date.now() - t0;
    console.log('trade.trace', { request_id: requestId, character_id: characterId, trace });
    try {
      await pgClient.end();
    } catch {
      // Ignore cleanup errors
    }
  }
});

async function handleTrade({
  pgClient,
  supabase,
  payload,
  characterId,
  requestId,
  adminOverride,
  actorCharacterId,
  taskId,
  trace,
  mark,
}: {
  pgClient: Client;
  supabase: ReturnType<typeof createServiceRoleClient>;
  payload: Record<string, unknown>;
  characterId: string;
  requestId: string;
  adminOverride: boolean;
  actorCharacterId: string | null;
  taskId: string | null;
  trace: Record<string, number>;
  mark: (label: string) => void;
}): Promise<Response> {
  const source = buildEventSource('trade', requestId);

  const character = await pgLoadCharacter(pgClient, characterId);
  mark('load_character');
  const ship = await pgLoadShip(pgClient, character.current_ship_id);
  mark('load_ship');
  const shipDefinition = await pgLoadShipDefinition(pgClient, ship.ship_type);
  mark('load_ship_definition');

  await pgEnsureActorAuthorization(pgClient, {
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  mark('auth');

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

  const portRowInitial = await pgLoadPortBySector(pgClient, sectorId);
  mark('load_port');
  if (!portRowInitial) {
    throw new TradeError('No port at current location', 400);
  }

  const shipCredits = ship.credits ?? 0;
  const shipCargo = buildCargoMap(ship);
  const cargoCapacity = shipDefinition.cargo_holds ?? 0;
  const cargoUsed = cargoTotal(shipCargo);

  const execution = await executeTradeWithRetry({
    pgClient,
    sectorId,
    commodity,
    tradeType,
    quantity,
    shipCredits,
    shipCargo,
    cargoCapacity,
    cargoUsed,
    initialPort: portRowInitial,
    shipId: ship.ship_id,
    ownerId: ship.owner_id,
    mark,
  });
  mark('trade_executed');

  const timestamp = execution.observedAt;
  await pgUpdateCharacterLastActive(pgClient, characterId);
  mark('update_last_active');

  await pgRecordPortTransaction(pgClient, {
    sectorId,
    portId: execution.updatedPort.port_id,
    characterId,
    shipId: ship.ship_id,
    commodity: commodityKey(commodity),
    quantity,
    transactionType: tradeType,
    pricePerUnit: execution.computation.pricePerUnit,
    totalPrice: execution.computation.totalPrice,
  });
  mark('record_transaction');

  // Build updated ship state for status payload (reuse character and definition)
  const updatedShip = {
    ...ship,
    credits: execution.computation.updatedCredits,
    cargo_qf: execution.computation.updatedCargo.quantum_foam,
    cargo_ro: execution.computation.updatedCargo.retro_organics,
    cargo_ns: execution.computation.updatedCargo.neuro_symbolics,
  };

  const statusPayload = await pgBuildStatusPayload(pgClient, characterId, {
    character,
    ship: updatedShip,
    shipDefinition,
  });
  mark('build_status');
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

  await pgEmitCharacterEvent({
    pg: pgClient,
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
    taskId,
    corpId: ship.owner_corporation_id ?? character.corporation_id,
  });
  mark('emit_trade_executed');

  await pgEmitCharacterEvent({
    pg: pgClient,
    characterId,
    eventType: 'status.update',
    payload: statusPayload,
    sectorId,
    shipId: ship.ship_id,
    requestId,
    actorCharacterId,
    taskId,
    corpId: ship.owner_corporation_id ?? character.corporation_id,
  });
  mark('emit_status_update');

  await pgEmitCharacterEvent({
    pg: pgClient,
    characterId,
    eventType: 'port.update',
    payload: portUpdatePayload,
    sectorId,
    shipId: ship.ship_id,
    requestId,
    actorCharacterId,
    taskId,
    corpId: ship.owner_corporation_id ?? character.corporation_id,
  });
  mark('emit_port_update');

  // Emit port update to other characters in sector
  const otherCharacters = await pgListCharactersInSector(pgClient, sectorId, [characterId]);
  mark('list_sector_chars');

  if (otherCharacters.length > 0) {
    await Promise.all(
      otherCharacters.map((recipient) =>
        pgEmitCharacterEvent({
          pg: pgClient,
          characterId: recipient,
          eventType: 'port.update',
          payload: portUpdatePayload,
          sectorId,
        })
      )
    );
    mark('emit_port_broadcast');
  }

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

async function executeTradeWithRetry(params: {
  pgClient: Client;
  sectorId: number;
  commodity: Commodity;
  tradeType: TradeType;
  quantity: number;
  shipCredits: number;
  shipCargo: Record<Commodity, number>;
  cargoCapacity: number;
  cargoUsed: number;
  initialPort: PortRow;
  shipId: string;
  ownerId: string | null;
  mark: (label: string) => void;
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
    const shipUpdates: ShipTradeUpdate = {
      credits: computation.updatedCredits,
      cargo_qf: computation.updatedCargo.quantum_foam,
      cargo_ro: computation.updatedCargo.retro_organics,
      cargo_ns: computation.updatedCargo.neuro_symbolics,
    };

    // Execute port + ship update in a transaction
    const result = await pgExecuteTradeTransaction(params.pgClient, {
      portRow: currentPort,
      updatedStock: computation.updatedPortStock,
      observedAt,
      shipId: params.shipId,
      ownerId: params.ownerId,
      shipUpdates,
    });

    if (result.success) {
      console.log(`[trade.retry] SUCCESS on attempt ${attempt + 1}, new version ${result.updatedPort.version}`);
      params.mark(`trade_attempt_${attempt + 1}`);
      return {
        computation,
        updatedPort: result.updatedPort,
        originalPort: currentPort,
        observedAt,
        portDataAfter: buildPortData(result.updatedPort),
      };
    }

    if (result.reason === 'ship_update_failed') {
      throw new TradeError('Failed to update ship after trade', 500);
    }

    // Version mismatch - retry with exponential backoff
    console.log(`[trade.retry] Port version mismatch on attempt ${attempt + 1}, refreshing...`);

    const baseDelayMs = 10;
    const maxJitterMs = baseDelayMs * Math.pow(2, attempt);
    const jitterMs = Math.random() * maxJitterMs;
    console.log(`[trade.retry] Backing off ${jitterMs.toFixed(1)}ms before retry`);
    await new Promise(resolve => setTimeout(resolve, jitterMs));

    const refreshed = await pgLoadPortBySector(params.pgClient, params.sectorId);
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

type TradeComputation = {
  updatedCredits: number;
  updatedCargo: Record<Commodity, number>;
  pricePerUnit: number;
  totalPrice: number;
  updatedPortStock: Record<string, number>;
};
