import { v5, validate as validateUuid } from 'https://deno.land/std@0.224.0/uuid/mod.ts';

function resolveNamespace(value: string | undefined, fallback: string): string {
  if (value && validateUuid(value.trim())) {
    return value.trim();
  }
  return fallback;
}

const LEGACY_NAMESPACE = resolveNamespace(
  Deno.env.get('SUPABASE_LEGACY_ID_NAMESPACE'),
  '5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b',
);
const SHIP_NAMESPACE = resolveNamespace(
  Deno.env.get('SUPABASE_SHIP_ID_NAMESPACE'),
  'b7b87641-1c44-4ed1-8e9c-5f671484b1a9',
);
const LEGACY_TOKENS = new Set(['1', 'true', 'on', 'yes']);

function allowLegacyIds(): boolean {
  const value = (Deno.env.get('SUPABASE_ALLOW_LEGACY_IDS') ?? '1').trim().toLowerCase();
  return LEGACY_TOKENS.has(value);
}

async function canonicalize(value: string, namespace: string): Promise<string> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Identifier cannot be empty');
  }
  if (validateUuid(trimmed)) {
    return trimmed;
  }
  if (!allowLegacyIds()) {
    throw new Error(`Invalid UUID: ${value}`);
  }
  const data = new TextEncoder().encode(trimmed);
  return await v5.generate(namespace, data);
}

export async function canonicalizeCharacterId(value: string): Promise<string> {
  return await canonicalize(value, LEGACY_NAMESPACE);
}

export async function canonicalizeShipId(value: string): Promise<string> {
  return await canonicalize(value, SHIP_NAMESPACE);
}
