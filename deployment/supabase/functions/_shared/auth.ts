import { create } from 'https://deno.land/x/djwt@v2.8/mod.ts';
import { timingSafeEqual } from 'https://deno.land/std@0.224.0/crypto/timing_safe_equal.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function getApiToken(): string | undefined {
  return Deno.env.get('EDGE_API_TOKEN') ?? Deno.env.get('SUPABASE_API_TOKEN') ?? undefined;
}

export function validateApiToken(req: Request): boolean {
  const apiToken = getApiToken();
  if (!apiToken) {
    // When the token is not configured we allow all requests (local dev convenience)
    return true;
  }

  const provided = req.headers.get('x-api-token') ?? req.headers.get('X-API-Token');
  return provided === apiToken;
}

export function unauthorizedResponse(): Response {
  return jsonResponse({ success: false, error: 'unauthorized' }, 401);
}

export function successResponse<T>(data: T, status = 200): Response {
  return jsonResponse({ success: true, ...((data as Record<string, unknown>) ?? {}) }, status);
}

export function errorResponse(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return jsonResponse({ success: false, error: message, ...(extra ?? {}) }, status);
}

const DEFAULT_JWT_TTL_SECONDS = 60 * 60; // 1 hour
const MIN_JWT_TTL_SECONDS = 60;
const MAX_JWT_TTL_SECONDS = 60 * 60 * 24;

let signingKeyPromise: Promise<{ key: CryptoKey; kid: string }> | null = null;

async function getSigningKey(): Promise<{ key: CryptoKey; kid: string }> {
  if (!signingKeyPromise) {
    signingKeyPromise = (async () => {
      const jwkJson = Deno.env.get('CHARACTER_JWT_SIGNING_KEY');
      if (!jwkJson) {
        throw new Error('CHARACTER_JWT_SIGNING_KEY not configured');
      }

      let jwk: JsonWebKey;
      try {
        jwk = JSON.parse(jwkJson);
      } catch (err) {
        throw new Error(`Failed to parse CHARACTER_JWT_SIGNING_KEY: ${err.message}`);
      }

      if (!jwk.kid) {
        throw new Error('JWK must have a kid (key ID)');
      }

      // Import ES256 private key
      const key = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      );

      return { key, kid: jwk.kid };
    })();
  }
  return await signingKeyPromise;
}

function normalizeTtlSeconds(value?: number | null): number {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return DEFAULT_JWT_TTL_SECONDS;
  }
  const integer = Math.floor(value);
  if (integer < MIN_JWT_TTL_SECONDS) {
    return MIN_JWT_TTL_SECONDS;
  }
  if (integer > MAX_JWT_TTL_SECONDS) {
    return MAX_JWT_TTL_SECONDS;
  }
  return integer;
}

export interface CharacterJwtOptions {
  characterId: string;
  expiresInSeconds?: number | null;
  audience?: string;
  claims?: Record<string, unknown>;
}

export async function generateCharacterJWT(options: CharacterJwtOptions): Promise<string> {
  const {
    characterId,
    expiresInSeconds = DEFAULT_JWT_TTL_SECONDS,
    audience = 'authenticated',
    claims = {},
  } = options;

  if (!characterId || typeof characterId !== 'string') {
    throw new Error('characterId is required to generate a JWT');
  }

  const ttl = normalizeTtlSeconds(expiresInSeconds);
  const now = Math.floor(Date.now() / 1000);
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const payload: Record<string, unknown> = {
    sub: characterId,
    iss: supabaseUrl,
    role: 'authenticated',
    aud: audience,
    iat: now,
    exp: now + ttl,
  };

  for (const [key, value] of Object.entries(claims)) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }

  let signingResult;
  try {
    signingResult = await getSigningKey();
  } catch (err) {
    throw new Error(`Failed to get signing key: ${err.message}`);
  }

  const { key, kid } = signingResult;

  try {
    return await create({ alg: 'ES256', typ: 'JWT', kid }, payload, key);
  } catch (err) {
    throw new Error(`Failed to sign JWT: ${err.message}`);
  }
}

const ADMIN_PASSWORD = Deno.env.get('EDGE_ADMIN_PASSWORD')
  ?? Deno.env.get('ADMIN_PASSWORD')
  ?? '';
const ADMIN_PASSWORD_HASH = Deno.env.get('EDGE_ADMIN_PASSWORD_HASH')
  ?? Deno.env.get('ADMIN_PASSWORD_HASH')
  ?? '';

export function isAdminSecretConfigured(): boolean {
  return Boolean(ADMIN_PASSWORD || ADMIN_PASSWORD_HASH);
}

function timingSafeCompare(expected: string, provided: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(expected);
  const right = encoder.encode(provided);
  if (left.length !== right.length) {
    return false;
  }
  try {
    return timingSafeEqual(left, right);
  } catch (_err) {
    return false;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function validateAdminSecret(candidate: unknown): Promise<boolean> {
  if (!isAdminSecretConfigured()) {
    return false;
  }
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return false;
  }
  if (ADMIN_PASSWORD) {
    return timingSafeCompare(ADMIN_PASSWORD, candidate);
  }
  const hashed = await sha256Hex(candidate);
  return timingSafeCompare(ADMIN_PASSWORD_HASH, hashed);
}
