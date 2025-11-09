import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { Client } from 'https://deno.land/x/postgres@v0.17.0/mod.ts';
import { validate as validateUuid } from 'https://deno.land/std@0.224.0/uuid/mod.ts';

import charactersFixture from './fixtures/characters.json' assert { type: 'json' };
import structureFixture from './fixtures/universe_structure.json' assert { type: 'json' };
import sectorContentsFixture from './fixtures/sector_contents.json' assert { type: 'json' };

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import {
  parseJsonRequest,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

const DEFAULT_RESET_RESPONSE = {
  cleared_tables: 0,
  inserted_characters: 0,
  inserted_ships: 0,
  sectors_seeded: 0,
};


const EXTRA_CHARACTERS = new Set(['test_reset_runner']);
const LEGACY_NAMESPACE = Deno.env.get('SUPABASE_LEGACY_ID_NAMESPACE') ?? '5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b';
const SHIP_NAMESPACE = Deno.env.get('SUPABASE_TEST_SHIP_NAMESPACE') ?? 'b7b87641-1c44-4ed1-8e9c-5f671484b1a9';
const legacyToggle = (Deno.env.get('SUPABASE_ALLOW_LEGACY_IDS') ?? '1').toLowerCase();
const ALLOW_LEGACY_IDS = new Set(['1', 'true', 'on', 'yes']).has(legacyToggle);

const DEFAULT_SHIP_TYPE = Deno.env.get('SUPABASE_TEST_SHIP_TYPE') ?? 'kestrel_courier';
const DEFAULT_SHIP_SUFFIX = Deno.env.get('SUPABASE_TEST_SHIP_SUFFIX') ?? '-ship';
const DEFAULT_SHIP_CREDITS = Number(Deno.env.get('SUPABASE_TEST_DEFAULT_SHIP_CREDITS') ?? '25000');
const DEFAULT_FIGHTERS = Number(Deno.env.get('SUPABASE_TEST_DEFAULT_FIGHTERS') ?? '250');
const DEFAULT_SHIELDS = Number(Deno.env.get('SUPABASE_TEST_DEFAULT_SHIELDS') ?? '150');
const DEFAULT_WARP = Number(Deno.env.get('SUPABASE_TEST_DEFAULT_WARP') ?? '300');

const PINNED_SECTORS: Record<string, number> = {
  test_2p_player1: 0,
  test_2p_player2: 0,
};

const DATABASE_URL = Deno.env.get('SUPABASE_DB_URL');
if (!DATABASE_URL) {
  throw new Error('SUPABASE_DB_URL is required for test_reset');
}


interface UniverseStructure {
  meta?: Record<string, unknown>;
  sectors?: Array<{
    id: number | string;
    position?: { x?: number; y?: number };
    region?: string;
    warps?: unknown;
  }>;
}

interface SectorContents {
  sectors?: Array<{
    id: number | string;
    port?: Record<string, unknown>;
  }>;
}

class TestResetError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'TestResetError';
    this.status = status;
  }
}

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('test_reset.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);

  try {
    const characterIds = parseCharacterIds(payload['character_ids']);
    const clearFiles = optionalBoolean(payload, 'clear_files');

    const result = await resetSupabaseState({ characterIds });
    result.clear_files = clearFiles === false ? false : true;

    return successResponse({ request_id: requestId, ...result });
  } catch (err) {
    if (err instanceof TestResetError) {
      return errorResponse(err.message, err.status);
    }
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    console.error('test_reset.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function resetSupabaseState(params: { characterIds: string[] | null }): Promise<Record<string, unknown>> {
  const characterIds = params.characterIds ?? (await loadDefaultCharacterIds());
  if (!characterIds.length) {
    throw new TestResetError('No character IDs available for reseed', 500);
  }

  const { universeStructure, sectorContents, availableSectors } = await loadUniverseData();
  if (!universeStructure) {
    throw new TestResetError('Universe structure fixtures are missing', 500);
  }

  const defaultSector = availableSectors[0] ?? 0;
  const distribution = availableSectors.filter((value) => value !== defaultSector);
  const assignments = characterIds.map((id, idx) => PINNED_SECTORS[id] ?? chooseSector(idx, distribution, defaultSector));

  const nowIso = new Date().toISOString();
  const characterRows = await buildCharacterRows(characterIds, assignments, nowIso);
  const shipRows = await buildShipRows(characterIds, assignments);

  const connection = new Client(DATABASE_URL);
  await connection.connect();
  try {
    await connection.queryArray('BEGIN');
    await truncateTables(connection);
    const sectorsSeeded = await seedUniverse(connection, universeStructure, sectorContents);
    await insertCharacters(connection, characterRows);
    await insertShips(connection, shipRows);
    await updateCharacterShips(connection, characterIds);
    await connection.queryArray('COMMIT');

    return {
      success: true,
      ...DEFAULT_RESET_RESPONSE,
      cleared_tables: 11,
      inserted_characters: characterRows.length,
      inserted_ships: shipRows.length,
      sectors_seeded: sectorsSeeded,
    };
  } catch (err) {
    try {
      await connection.queryArray('ROLLBACK');
    } catch (rollbackErr) {
      console.error('test_reset.rollback_failed', rollbackErr);
    }
    console.error('test_reset.reset_failed', err);
    throw new TestResetError('failed to reset database state', 500);
  } finally {
    await connection.end();
  }
}

async function truncateTables(connection: Client): Promise<void> {
  await connection.queryArray(`
    TRUNCATE TABLE
      events,
      rate_limits,
      garrisons,
      ports,
      corporation_members,
      corporation_ships,
      corporations,
      ship_instances,
      characters,
      sector_contents,
      universe_structure,
      universe_config
    RESTART IDENTITY CASCADE;
  `);
}

async function seedUniverse(
  connection: Client,
  structure: UniverseStructure,
  contents: SectorContents | null,
): Promise<number> {
  const sectorEntries = (structure.sectors ?? []).map((sector) => ({ ...sector, id: Number(sector.id) }));
  const contentsBySector = new Map<number, Record<string, unknown>>();
  if (contents?.sectors) {
    for (const entry of contents.sectors) {
      if (!entry || entry.id === undefined) continue;
      const portData = entry.port;
      if (portData && typeof portData === 'object') {
        contentsBySector.set(Number(entry.id), portData as Record<string, unknown>);
      }
    }
  }

  const meta = structure.meta ?? {};
  const sectorCount = Number(meta['sector_count'] ?? sectorEntries.length);
  await connection.queryArray({
    text: `INSERT INTO universe_config (id, sector_count, generation_seed, generation_params, meta)
           VALUES (1, $1, $2, $3, $4)`,
    args: [
      sectorCount,
      meta['seed'] ?? null,
      JSON.stringify(meta),
      JSON.stringify({ source: 'tests/test-world-data' }),
    ],
  });

  for (const sector of sectorEntries) {
    const position = sector.position ?? {};
    await connection.queryArray({
      text: `INSERT INTO universe_structure (sector_id, position_x, position_y, region, warps)
             VALUES ($1, $2, $3, $4, $5)`,
      args: [
        sector.id,
        Number(position['x'] ?? 0),
        Number(position['y'] ?? 0),
        sector.region ?? 'testbed',
        JSON.stringify(sector.warps ?? []),
      ],
    });

    const portData = contentsBySector.get(sector.id);
    let portId: number | null = null;
    if (portData) {
      const insertResult = await connection.queryObject<{ port_id: number }>({
        text: `INSERT INTO ports (
                 sector_id, port_code, port_class,
                 max_qf, max_ro, max_ns,
                 stock_qf, stock_ro, stock_ns
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING port_id`,
        args: [
          sector.id,
          String((portData['code'] ?? 'PRT')).toUpperCase().slice(0, 3),
          Number(portData['class'] ?? 1),
          bucketValue(portData['stock_max'], 'QF'),
          bucketValue(portData['stock_max'], 'RO'),
          bucketValue(portData['stock_max'], 'NS'),
          bucketValue(portData['stock'], 'QF'),
          bucketValue(portData['stock'], 'RO'),
          bucketValue(portData['stock'], 'NS'),
        ],
      });
      portId = insertResult.rows[0]?.port_id ?? null;
    }

    await connection.queryArray({
      text: `INSERT INTO sector_contents (sector_id, port_id, combat, salvage, observer_channels)
             VALUES ($1, $2, $3, $4, $5)`,
      args: [
        sector.id,
        portId,
        null,
        JSON.stringify([]),
        JSON.stringify([]),
      ],
    });
  }

  return sectorEntries.length;
}

function bucketValue(bucket: unknown, key: string): number {
  if (!bucket || typeof bucket !== 'object') {
    return 0;
  }
  const value = (bucket as Record<string, unknown>)[key];
  const parsed = Number(value ?? 0);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return 0;
}

async function insertCharacters(
  connection: Client,
  rows: CharacterRow[],
): Promise<void> {
  for (const row of rows) {
    if (!validateUuid(row.characterId)) {
      console.error('test_reset.invalid_character_uuid', row.name, row.characterId);
    }
    try {
      await connection.queryArray({
        text: `INSERT INTO characters (
                 character_id,
                 name,
                 credits_in_megabank,
                 map_knowledge,
                 player_metadata,
                 is_npc,
                 created_at,
                 last_active,
                 first_visit
               ) VALUES ($1, $2, $3, $4, $5, false, $6, $6, $6)
               ON CONFLICT (character_id) DO UPDATE SET
                 name = EXCLUDED.name,
                 credits_in_megabank = EXCLUDED.credits_in_megabank,
                 map_knowledge = EXCLUDED.map_knowledge,
                 player_metadata = EXCLUDED.player_metadata,
                 is_npc = EXCLUDED.is_npc,
                 created_at = EXCLUDED.created_at,
                 last_active = EXCLUDED.last_active,
                 first_visit = EXCLUDED.first_visit`,
        args: [
          row.characterId,
          row.name,
          DEFAULT_SHIP_CREDITS,
          JSON.stringify(row.mapKnowledge),
          JSON.stringify({}),
          row.timestamp,
        ],
      });
    } catch (err) {
      console.error('test_reset.insert_character_failed', row.name, err);
      throw err;
    }
  }
}

async function insertShips(
  connection: Client,
  rows: ShipRow[],
): Promise<void> {
  for (const row of rows) {
    try {
      await connection.queryArray({
        text: `INSERT INTO ship_instances (
                 ship_id,
                 owner_id,
                 owner_character_id,
                 ship_type,
                 ship_name,
                 current_sector,
                 in_hyperspace,
                 credits,
                 cargo_qf,
                 cargo_ro,
                 cargo_ns,
                 current_warp_power,
                 current_shields,
                 current_fighters,
                 metadata,
                 owner_type,
                 owner_corporation_id
               ) VALUES (
                 $1, $2, $2, $3, $4, $5,
                 false,
                 $6,
                 0, 0, 0,
                 $7,
                 $8,
                 $9,
                 $10,
                 'character',
                 NULL
               )
               ON CONFLICT (ship_id) DO UPDATE SET
                 owner_id = EXCLUDED.owner_id,
                 owner_character_id = EXCLUDED.owner_character_id,
                 ship_type = EXCLUDED.ship_type,
                 ship_name = EXCLUDED.ship_name,
                 current_sector = EXCLUDED.current_sector,
                 credits = EXCLUDED.credits,
                 current_warp_power = EXCLUDED.current_warp_power,
                 current_shields = EXCLUDED.current_shields,
                 current_fighters = EXCLUDED.current_fighters,
                 metadata = EXCLUDED.metadata,
                 owner_type = EXCLUDED.owner_type,
                 owner_corporation_id = EXCLUDED.owner_corporation_id`,
        args: [
          row.shipId,
          row.characterId,
          row.shipType,
          row.shipName,
          row.sector,
          DEFAULT_SHIP_CREDITS,
          DEFAULT_WARP,
          DEFAULT_SHIELDS,
          DEFAULT_FIGHTERS,
          JSON.stringify({}),
        ],
      });
    } catch (err) {
      console.error('test_reset.insert_ship_failed', row.shipName, err);
      throw err;
    }
  }
}

async function updateCharacterShips(
  connection: Client,
  characterIds: string[],
): Promise<void> {
  for (const name of characterIds) {
    const characterId = await canonicalizeCharacterId(name);
    const shipId = await shipIdFor(name);
    await connection.queryArray({
      text: `UPDATE characters SET current_ship_id = $1 WHERE character_id = $2`,
      args: [shipId, characterId],
    });
  }
}

interface CharacterRow {
  characterId: string;
  name: string;
  mapKnowledge: Record<string, unknown>;
  timestamp: string;
}

interface ShipRow {
  shipId: string;
  characterId: string;
  shipType: string;
  shipName: string;
  sector: number;
}

async function buildCharacterRows(ids: string[], sectors: number[], timestamp: string): Promise<CharacterRow[]> {
  const rows = await Promise.all(
    ids.map(async (name, idx) => ({
      characterId: await canonicalizeCharacterId(name),
      name,
      mapKnowledge: buildMapKnowledge(sectors[idx] ?? 0, timestamp),
      timestamp,
    })),
  );
  return rows;
}

async function buildShipRows(ids: string[], sectors: number[]): Promise<ShipRow[]> {
  const rows = await Promise.all(
    ids.map(async (name, idx) => ({
      shipId: await shipIdFor(name),
      characterId: await canonicalizeCharacterId(name),
      shipType: DEFAULT_SHIP_TYPE,
      shipName: `${name}${DEFAULT_SHIP_SUFFIX}`,
      sector: sectors[idx] ?? 0,
    })),
  );
  return rows;
}

function buildMapKnowledge(sectorId: number, timestamp: string): Record<string, unknown> {
  return {
    current_sector: sectorId,
    total_sectors_visited: 1,
    sectors_visited: {
      [String(sectorId)]: {
        last_visited: timestamp,
        adjacent_sectors: [],
        position: [0, 0],
      },
    },
  };
}

async function canonicalizeCharacterId(value: string): Promise<string> {
  const trimmed = value.trim();
  if (validateUuid(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (!ALLOW_LEGACY_IDS) {
    throw new TestResetError(`invalid character_id: ${value}`, 400);
  }
  return await generateUuidV5(LEGACY_NAMESPACE, trimmed);
}

async function shipIdFor(value: string): Promise<string> {
  return await generateUuidV5(SHIP_NAMESPACE, value.trim());
}

async function loadDefaultCharacterIds(): Promise<string[]> {
  const registry = (charactersFixture as { characters?: Record<string, unknown> })?.characters ?? {};
  const ids = new Set<string>();
  for (const key of Object.keys(registry)) {
    ids.add(key);
  }
  for (const extra of EXTRA_CHARACTERS) {
    ids.add(extra);
  }
  return Array.from(ids).sort();
}

async function loadUniverseData(): Promise<{
  universeStructure: UniverseStructure | null;
  sectorContents: SectorContents | null;
  availableSectors: number[];
}> {
  const structure = structureFixture as UniverseStructure;
  const contents = sectorContentsFixture as SectorContents;
  const available = computeAvailableSectors(structure);
  return { universeStructure: structure, sectorContents: contents, availableSectors: available };
}

function computeAvailableSectors(structure: UniverseStructure | null): number[] {
  if (!structure?.sectors?.length) {
    return [0];
  }
  const ids = structure.sectors
    .map((sector) => Number(sector.id))
    .filter((value) => Number.isFinite(value));
  const unique = Array.from(new Set(ids));
  unique.sort((a, b) => a - b);
  return unique.length ? unique : [0];
}

function chooseSector(index: number, distribution: number[], fallback: number): number {
  if (!distribution.length) {
    return fallback;
  }
  return distribution[index % distribution.length] ?? fallback;
}

async function generateUuidV5(namespace: string, value: string): Promise<string> {
  const nsBytes = uuidToBytes(namespace);
  const valueBytes = new TextEncoder().encode(value);
  const input = new Uint8Array(nsBytes.length + valueBytes.length);
  input.set(nsBytes);
  input.set(valueBytes, nsBytes.length);
  const hashBuffer = await crypto.subtle.digest('SHA-1', input);
  const hash = new Uint8Array(hashBuffer.slice(0, 16));
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  return bytesToUuid(hash);
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) {
    throw new TestResetError(`invalid UUID namespace: ${uuid}`, 500);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    const slice = hex.slice(i * 2, i * 2 + 2);
    bytes[i] = Number.parseInt(slice, 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  bytes.forEach((byte, idx) => {
    hex.push(byte.toString(16).padStart(2, '0'));
    if (idx === 3 || idx === 5 || idx === 7 || idx === 9) {
      hex.push('-');
    }
  });
  return hex.join('');
}

function parseCharacterIds(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new TestResetError('character_ids must be an array of strings', 400);
  }
  const ids = Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0),
    ),
  ).sort();
  if (!ids.length) {
    throw new TestResetError('character_ids cannot be empty', 400);
  }
  return ids;
}
