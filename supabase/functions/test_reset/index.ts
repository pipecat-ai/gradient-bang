import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
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
  test_api_list_ports: 0,
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for test_reset');
}

// Helper to make REST API calls to Supabase
async function supabaseRest(path: string, method: string, body?: unknown, returnData = false): Promise<Response> {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': SUPABASE_ANON_KEY ?? SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    'Prefer': returnData ? 'return=representation' : 'return=minimal',
  };

  const options: RequestInit = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  return await fetch(url, options);
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
  // Default to empty array - tests should create characters via join() calls
  const characterIds = params.characterIds ?? [];

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

  try {
    // Clear all tables using REST API
    console.log('test_reset.truncating_tables');
    await truncateTables();
    console.log('test_reset.tables_truncated');

    // Seed universe data
    console.log('test_reset.seeding_universe');
    const sectorsSeeded = await seedUniverse(universeStructure, sectorContents);
    console.log(`test_reset.universe_seeded sectors=${sectorsSeeded}`);

    // Insert characters and ships
    console.log(`test_reset.inserting_characters count=${characterRows.length}`);
    await insertCharacters(characterRows);
    console.log('test_reset.characters_inserted');

    console.log(`test_reset.inserting_ships count=${shipRows.length}`);
    await insertShips(shipRows);
    console.log('test_reset.ships_inserted');

    console.log('test_reset.updating_character_ships');
    await updateCharacterShips(characterIds);
    console.log('test_reset.character_ships_updated');

    return {
      success: true,
      ...DEFAULT_RESET_RESPONSE,
      cleared_tables: 11,
      inserted_characters: characterRows.length,
      inserted_ships: shipRows.length,
      sectors_seeded: sectorsSeeded,
    };
  } catch (err) {
    console.error('test_reset.reset_failed', err, err?.message, err?.stack);
    throw new TestResetError(`failed to reset database state: ${err?.message ?? err}`, 500);
  }
}

async function truncateTables(): Promise<void> {
  // Delete all rows from tables using REST API
  // Order matters due to foreign key constraints

  // First, NULL out circular FKs on characters table
  const nullFKsResp = await supabaseRest(
    '/characters?character_id=neq.00000000-0000-0000-0000-000000000000',
    'PATCH',
    { current_ship_id: null, corporation_id: null }
  );
  if (!nullFKsResp.ok && nullFKsResp.status !== 404) {
    console.error(`test_reset.null_character_fks_failed status=${nullFKsResp.status}`);
  }

  // Delete tables in dependency order
  // Each entry: [table_name, primary_key_column]
  const tables: Array<[string, string]> = [
    ['events', 'id'],                     // FK: character_id → characters
    ['rate_limits', 'character_id'],      // FK: character_id → characters
    ['corporation_members', 'corp_id'],   // FK: corp_id → corporations, character_id → characters
    ['corporation_ships', 'ship_id'],     // FK: ship_id → ship_instances, corp_id → corporations
    ['corporations', 'corp_id'],          // FK: founder_id → characters
    ['garrisons', 'sector_id'],           // FK: sector_id → universe_structure
    ['ship_instances', 'ship_id'],        // FK: owner_character_id → characters, current_sector → universe_structure
    ['characters', 'character_id'],       // FK: current_ship_id → ship_instances (now NULL'd)
    ['sector_contents', 'sector_id'],     // FK: sector_id → universe_structure, port_id → ports
    ['ports', 'sector_id'],               // FK: sector_id → universe_structure
    ['universe_structure', 'sector_id'],  // FK: none
    ['universe_config', 'id'],            // FK: none
  ];

  for (const [table, pkColumn] of tables) {
    // Delete all rows by using a broad filter on the primary key
    // For UUID/text columns (character_id, ship_id, corp_id, etc), match all non-null values
    // For numeric columns (id, sector_id), use gte.0
    let filter: string;
    if (pkColumn === 'id') {
      filter = 'id=gte.0';
    } else if (pkColumn === 'sector_id') {
      filter = 'sector_id=gte.0';
    } else {
      // UUID columns (character_id, ship_id, corp_id) - match all non-null values
      filter = `${pkColumn}=neq.00000000-0000-0000-0000-000000000000`;
    }

    const resp = await supabaseRest(`/${table}?${filter}`, 'DELETE');
    if (!resp.ok && resp.status !== 404) {
      const errorText = await resp.text();
      console.error(`test_reset.truncate_failed table=${table} status=${resp.status} error=${errorText}`);
      throw new Error(`Failed to truncate table ${table}: ${resp.statusText}`);
    }
  }
}

async function seedUniverse(
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

  // Insert universe config
  const meta = structure.meta ?? {};
  const sectorCount = Number(meta['sector_count'] ?? sectorEntries.length);
  const configResp = await supabaseRest('/universe_config', 'POST', {
    id: 1,
    sector_count: sectorCount,
    generation_seed: meta['seed'] ?? null,
    generation_params: meta,
    meta: { source: 'tests/test-world-data' },
  });
  if (!configResp.ok) {
    throw new Error(`Failed to insert universe_config: ${configResp.statusText}`);
  }

  // Insert sectors and ports
  for (const sector of sectorEntries) {
    const position = sector.position ?? {};

    // Insert universe_structure
    const structResp = await supabaseRest('/universe_structure', 'POST', {
      sector_id: sector.id,
      position_x: Number(position['x'] ?? 0),
      position_y: Number(position['y'] ?? 0),
      region: sector.region ?? 'testbed',
      warps: sector.warps ?? [],
    });
    if (!structResp.ok) {
      throw new Error(`Failed to insert universe_structure for sector ${sector.id}: ${structResp.statusText}`);
    }

    // Insert port if exists
    const portData = contentsBySector.get(sector.id);
    let portId: number | null = null;
    if (portData) {
      const portResp = await supabaseRest('/ports?select=port_id', 'POST', {
        sector_id: sector.id,
        port_code: String((portData['code'] ?? 'PRT')).toUpperCase().slice(0, 3),
        port_class: Number(portData['class'] ?? 1),
        max_qf: bucketValue(portData['stock_max'], 'QF'),
        max_ro: bucketValue(portData['stock_max'], 'RO'),
        max_ns: bucketValue(portData['stock_max'], 'NS'),
        stock_qf: bucketValue(portData['stock'], 'QF'),
        stock_ro: bucketValue(portData['stock'], 'RO'),
        stock_ns: bucketValue(portData['stock'], 'NS'),
      }, true); // returnData = true to get port_id back
      if (portResp.ok) {
        const portResult = await portResp.json();
        portId = portResult[0]?.port_id ?? null;
      }
    }

    // Insert sector_contents
    const contentsResp = await supabaseRest('/sector_contents', 'POST', {
      sector_id: sector.id,
      port_id: portId,
      combat: null,
      salvage: [],
      observer_channels: [],
    });
    if (!contentsResp.ok) {
      throw new Error(`Failed to insert sector_contents for sector ${sector.id}: ${contentsResp.statusText}`);
    }
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
  rows: CharacterRow[],
): Promise<void> {
  // Batch insert characters to avoid timeout with large datasets
  const BATCH_SIZE = 100;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const bodies = batch.map(row => {
      if (!validateUuid(row.characterId)) {
        console.error('test_reset.invalid_character_uuid', row.name, row.characterId);
      }
      return {
        character_id: row.characterId,
        name: row.name,
        credits_in_megabank: DEFAULT_SHIP_CREDITS,
        map_knowledge: row.mapKnowledge,
        player_metadata: {},
        is_npc: false,
        created_at: row.timestamp,
        last_active: row.timestamp,
        first_visit: row.timestamp,
      };
    });

    try {
      const resp = await supabaseRest('/characters', 'POST', bodies);
      if (!resp.ok) {
        const errorText = await resp.text();
        console.error('test_reset.insert_characters_batch_failed', i, resp.status, errorText);
        throw new Error(`Failed to insert character batch at index ${i}: ${resp.statusText}`);
      }
    } catch (err) {
      console.error('test_reset.insert_characters_batch_failed', i, err);
      throw err;
    }
  }
}

async function insertShips(
  rows: ShipRow[],
): Promise<void> {
  // Batch insert ships to avoid timeout with large datasets
  const BATCH_SIZE = 100;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const bodies = batch.map(row => ({
      ship_id: row.shipId,
      owner_id: row.characterId,
      owner_character_id: row.characterId,
      ship_type: row.shipType,
      ship_name: row.shipName,
      current_sector: row.sector,
      in_hyperspace: false,
      credits: DEFAULT_SHIP_CREDITS,
      cargo_qf: 0,
      cargo_ro: 0,
      cargo_ns: 0,
      current_warp_power: DEFAULT_WARP,
      current_shields: DEFAULT_SHIELDS,
      current_fighters: DEFAULT_FIGHTERS,
      metadata: {},
      owner_type: 'character',
      owner_corporation_id: null,
    }));

    try {
      const resp = await supabaseRest('/ship_instances', 'POST', bodies);
      if (!resp.ok) {
        const errorText = await resp.text();
        console.error('test_reset.insert_ships_batch_failed', i, resp.status, errorText);
        throw new Error(`Failed to insert ship batch at index ${i}: ${resp.statusText}`);
      }
    } catch (err) {
      console.error('test_reset.insert_ships_batch_failed', i, err);
      throw err;
    }
  }
}

async function updateCharacterShips(
  characterIds: string[],
): Promise<void> {
  for (const name of characterIds) {
    const characterId = await canonicalizeCharacterId(name);
    const shipId = await shipIdFor(name);

    const resp = await supabaseRest(
      `/characters?character_id=eq.${characterId}`,
      'PATCH',
      { current_ship_id: shipId }
    );

    if (!resp.ok) {
      console.error('test_reset.update_character_ship_failed', name, resp.status, await resp.text());
      throw new Error(`Failed to update character ${name} ship: ${resp.statusText}`);
    }
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
