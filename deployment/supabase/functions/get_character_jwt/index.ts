import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';
import { create } from 'https://deno.land/x/djwt@v2.8/mod.ts';

import {
  validateApiToken,
  unauthorizedResponse,
  successResponse,
  errorResponse,
  generateCharacterJWT,
  validateAdminSecret,
} from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';
import {
  parseJsonRequest,
  requireString,
  optionalNumber,
  optionalBoolean,
  optionalString,
  respondWithError,
} from '../_shared/request.ts';

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60 * 24; // 24 hours

function clampTtl(value: number | null): number {
  if (value === null || Number.isNaN(value)) {
    return DEFAULT_TTL_SECONDS;
  }
  const intValue = Math.floor(value);
  if (intValue < MIN_TTL_SECONDS) {
    return MIN_TTL_SECONDS;
  }
  if (intValue > MAX_TTL_SECONDS) {
    return MAX_TTL_SECONDS;
  }
  return intValue;
}

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    console.error('get_character_jwt.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok' });
  }

  if (payload.diagnostic === true) {
    const jwkJson = Deno.env.get('CHARACTER_JWT_SIGNING_KEY');
    const hasEnvVar = Boolean(jwkJson);
    const envVarLength = jwkJson?.length ?? 0;

    let parseResult = 'not attempted';
    let jwkKeys = [];
    let parseError = null;
    let importResult = 'not attempted';
    let importError = null;
    let kid = null;
    let signResult = 'not attempted';
    let signError = null;

    if (jwkJson) {
      try {
        const parsed = JSON.parse(jwkJson);
        jwkKeys = Object.keys(parsed);
        parseResult = 'success';
        kid = parsed.kid;

        // Try to import the key
        try {
          const key = await crypto.subtle.importKey(
            'jwk',
            parsed,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign'],
          );
          importResult = 'success';

          // Try to sign a test payload
          try {
            const testPayload = {
              sub: 'test',
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 60,
            };
            const jwt = await create({ alg: 'ES256', typ: 'JWT', kid }, testPayload, key);
            signResult = 'success';
          } catch (err) {
            signError = err.message;
            signResult = 'failed';
          }
        } catch (err) {
          importError = err.message;
          importResult = 'failed';
        }
      } catch (err) {
        parseError = err.message;
        parseResult = 'failed';
      }
    }

    return successResponse({
      diagnostic: true,
      has_env_var: hasEnvVar,
      env_var_length: envVarLength,
      parse_result: parseResult,
      parse_error: parseError,
      jwk_keys: jwkKeys,
      kid: kid,
      import_result: importResult,
      import_error: importError,
      sign_result: signResult,
      sign_error: signError,
    });
  }

  const rawCharacterId = requireString(payload, 'character_id');
  const characterId = await canonicalizeCharacterId(rawCharacterId);
  const ttlSeconds = clampTtl(optionalNumber(payload, 'expires_in_seconds'));
  const requestAdminClaim = optionalBoolean(payload, 'is_admin') ?? false;
  const adminPassword = optionalString(payload, 'admin_password');

  const { data: characterRow, error: characterError } = await supabase
    .from('characters')
    .select('character_id, corporation_id')
    .eq('character_id', characterId)
    .maybeSingle();

  if (characterError) {
    console.error('get_character_jwt.load_character', characterError);
    return errorResponse('failed to load character', 500);
  }
  if (!characterRow) {
    return errorResponse('character not found', 404);
  }

  if (requestAdminClaim) {
    const adminValid = await validateAdminSecret(adminPassword);
    if (!adminValid) {
      return errorResponse('invalid admin password', 403);
    }
  }

  const claims: Record<string, unknown> = {};
  if (characterRow.corporation_id) {
    claims.corp_id = characterRow.corporation_id;
  }
  if (requestAdminClaim) {
    claims.is_admin = true;
  }

  let jwt: string;
  try {
    jwt = await generateCharacterJWT({
      characterId,
      expiresInSeconds: ttlSeconds,
      audience: 'authenticated',
      claims,
    });
  } catch (err) {
    console.error('get_character_jwt.generate', err);
    return errorResponse('failed to generate token', 500);
  }

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  return successResponse({
    character_id: characterId,
    jwt,
    expires_in_seconds: ttlSeconds,
    expires_at: expiresAt,
    corp_id: characterRow.corporation_id ?? null,
    is_admin: requestAdminClaim,
  });
});
