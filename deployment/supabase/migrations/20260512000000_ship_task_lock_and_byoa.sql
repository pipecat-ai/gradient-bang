-- BYOA ownership columns + long-lived BYOA token primitive.
--
-- Earlier revisions of this migration also introduced DB-persistent ship-task
-- lock columns (current_task_id, task_started_at, task_actor_character_id,
-- task_last_heartbeat_at, byoa_session_channel, byoa_session_allocated_at) and
-- the acquire/release/force_release/refresh_heartbeats RPCs. Those were
-- removed: the lock now lives in-memory in the bot process (see
-- VoiceAgent._locked_ships) with crash detection via the BYOA presence
-- heartbeat and TASK_AGENT_TIMEOUT. See CHANGELOG.md for rationale.

-- ---------------------------------------------------------------------------
-- Columns on ship_instances
-- ---------------------------------------------------------------------------

ALTER TABLE ship_instances
  ADD COLUMN byoa_owner_character_id    UUID NULL,
  ADD COLUMN byoa_mode                  TEXT NOT NULL DEFAULT 'private'
    CHECK (byoa_mode = 'private');

COMMENT ON COLUMN ship_instances.byoa_owner_character_id IS
  'For BYOA corp ships: the player whose external agent controls this ship. NULL = not a BYOA ship.';
COMMENT ON COLUMN ship_instances.byoa_mode IS
  'BYOA-only: currently always ''private''. BYOA ships are owner-only in this phase; the column is retained for forward-compatible UI/API shape.';

-- =============================================================================
-- BYOA tokens
--
-- `byoa_tokens` — long-lived HS256 token records bound to a character_id.
-- An operator mints one via the `byoa_token_mint` edge function
-- (Supabase-JWT-authed), receives the plaintext JWT exactly once, and stores
-- it on their machine. The DB stores only a SHA-256 hash so the plaintext is
-- never recoverable. Revocation flips `revoked_at`; the bus wrappers check
-- both signature validity AND the stored row's revocation/expiry on every
-- call.
--
-- Reuses the HS256 signing primitive provisioned by the 0.4.1 pubsub
-- migration (`pubsub_internal_secret`). Rotation: UPDATE the app_runtime_config
-- row, restart any sessions. BYOA tokens issued under the old secret stop
-- verifying on rotation — the desired post-rotation behaviour.
-- =============================================================================

-- pgcrypto provides `digest()` used by verify_byoa_token to hash the
-- inbound JWT for table lookup. Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- byoa_tokens
-- -----------------------------------------------------------------------------

CREATE TABLE public.byoa_tokens (
  token_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  uuid NOT NULL REFERENCES public.characters(character_id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz NULL,
  revoked_at    timestamptz NULL,
  CONSTRAINT byoa_tokens_label_nonblank CHECK (length(trim(label)) > 0)
);

-- Owner lookup for the future "list my tokens" UI (Phase 4) and the
-- mint-then-revoke-old rotation flow.
CREATE INDEX byoa_tokens_character_idx
  ON public.byoa_tokens(character_id)
  WHERE revoked_at IS NULL;

-- Hash lookup is the gateway hot path; UNIQUE already gives us the index.

COMMENT ON TABLE public.byoa_tokens IS
  'Long-lived HS256 BYOA tokens bound to a character_id. The plaintext JWT is returned once at mint time and never stored; only SHA-256 hash persists. Revocation flips revoked_at; gateway rejects on hash miss, revoked_at NOT NULL, or expires_at < NOW().';

-- -----------------------------------------------------------------------------
-- verify_byoa_token: signature + revocation + last-used touch
--
-- Called by the BYOA gateway (Phase 3 (3/N) edge functions). Returns the
-- token's bound character_id on success, NULL on any auth failure (invalid
-- sig, wrong token_type claim, missing/revoked/expired row). On success,
-- updates last_used_at lazily so operators can see token activity from the
-- Phase 4 management UI.
--
-- SECURITY DEFINER + REVOKE FROM PUBLIC keeps the underlying table writes
-- privileged; only the gateway edge functions (service_role) can call this.
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.verify_byoa_token(p_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_payload     json;
  v_valid       boolean;
  v_character   uuid;
  v_token_hash  text;
  v_token_row   public.byoa_tokens%ROWTYPE;
BEGIN
  -- Verify HS256 signature + standard exp claim via pgjwt. pgjwt's verify
  -- can raise on malformed JWTs (e.g. missing dots, non-base64 payload),
  -- so any exception is treated as "invalid token" rather than propagating.
  BEGIN
    SELECT payload, valid
      INTO v_payload, v_valid
      FROM extensions.verify(
        p_token,
        public.pubsub_internal_secret(),
        'HS256'
      );
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  IF v_valid IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  -- Defense against cross-token-type reuse (e.g. an internal pubsub token
  -- being passed off as a BYOA token).
  IF v_payload->>'token_type' IS DISTINCT FROM 'byoa' THEN
    RETURN NULL;
  END IF;
  IF v_payload->>'iss' IS DISTINCT FROM 'byoa_token_mint' THEN
    RETURN NULL;
  END IF;

  v_character := NULLIF(v_payload->>'character_id', '')::uuid;
  IF v_character IS NULL THEN
    RETURN NULL;
  END IF;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  SELECT *
    INTO v_token_row
    FROM public.byoa_tokens
    WHERE token_hash = v_token_hash;

  IF NOT FOUND
     OR v_token_row.revoked_at IS NOT NULL
     OR v_token_row.expires_at < NOW()
     OR v_token_row.character_id <> v_character
  THEN
    RETURN NULL;
  END IF;

  UPDATE public.byoa_tokens
     SET last_used_at = NOW()
   WHERE token_id = v_token_row.token_id;

  RETURN v_character;
END;
$$;

COMMENT ON FUNCTION public.verify_byoa_token IS
  'Verifies an HS256 BYOA token: pgjwt signature check, token_type/iss claim guards, byoa_tokens row lookup (hash, not revoked, not expired, matching character). Updates last_used_at on success. Returns bound character_id on success or NULL on any failure.';

REVOKE ALL ON FUNCTION public.verify_byoa_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_byoa_token(text) TO service_role;
