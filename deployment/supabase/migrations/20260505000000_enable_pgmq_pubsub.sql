-- =============================================================================
-- Enable pgmq pubsub event delivery with per-character authentication
-- =============================================================================
--
-- This migration:
--   1. Enables pgmq + pgjwt extensions
--   2. Creates a locked-down `pubsub_client` Postgres role
--   3. Adds SECURITY DEFINER functions for authenticated subscribe/archive
--   4. Creates per-character pgmq queues via INSERT trigger on `characters`
--   5. Backfills queues for existing characters
--
-- Auth model: clients connect as `pubsub_client` and call only
-- `subscribe_my_events` / `archive_my_events`. Both functions verify the
-- caller's Supabase Auth access_token (HS256 via pgjwt) and check character
-- ownership — direct via `user_characters`, or via corp membership for corp
-- ships. The `pubsub_client` role has no direct grants on the `pgmq` schema,
-- so cross-character access is impossible even with a misbehaving client.
--
-- See plan file (i-think-we-should-steady-feigenbaum.md) for full context.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- Locked-down role used by pubsub clients.
--
-- Login password is set out-of-band (env-managed; see PGMQ_URL in
-- env.bot.example). Local dev: `ALTER ROLE pubsub_client WITH LOGIN PASSWORD ...`
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE ROLE pubsub_client NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Defense in depth: ensure pubsub_client cannot read pgmq tables directly.
REVOKE ALL ON SCHEMA pgmq FROM pubsub_client;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM pubsub_client;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pgmq FROM pubsub_client;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM pubsub_client;

-- -----------------------------------------------------------------------------
-- Queue lifecycle helper
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_character_queue(p_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
BEGIN
  PERFORM pgmq.create('chr_' || p_character_id::text);
EXCEPTION
  WHEN duplicate_table THEN
    -- Queue already exists; treat as success.
    NULL;
END;
$$;

COMMENT ON FUNCTION public.ensure_character_queue IS
  'Idempotent: ensure a pgmq queue exists for a character_id. Called automatically via trigger on INSERT INTO characters.';

-- -----------------------------------------------------------------------------
-- Ownership predicate: can user U access character/ship C?
-- Direct ownership OR corp ship in user's corp.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_user_access_character(
  p_user_id uuid,
  p_character_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Direct ownership: user owns this character via user_characters
  SELECT EXISTS (
    SELECT 1 FROM public.user_characters
    WHERE user_id = p_user_id
      AND character_id = p_character_id
  )
  OR
  -- Corp membership: target is a corp ship in a corp where the user owns
  -- a member character (corp ships are dual-registered: row in `characters`
  -- with character_id == ship_id, plus row in `ship_instances` with
  -- owner_type='corporation').
  EXISTS (
    SELECT 1
    FROM public.ship_instances target_ship
    JOIN public.user_characters uc ON true
    JOIN public.characters my_char ON my_char.character_id = uc.character_id
    WHERE target_ship.ship_id = p_character_id
      AND target_ship.owner_type = 'corporation'
      AND uc.user_id = p_user_id
      AND my_char.corporation_id = target_ship.owner_corporation_id
  );
$$;

COMMENT ON FUNCTION public.can_user_access_character IS
  'Returns true if user U can access character/ship C. Direct ownership via user_characters, OR corp ship via corp membership.';

-- -----------------------------------------------------------------------------
-- subscribe_my_events: authenticated long-poll read
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.subscribe_my_events(
  p_character_id uuid,
  p_access_token text,
  p_max_seconds integer DEFAULT 30,
  p_qty integer DEFAULT 100
) RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_payload json;
  v_valid boolean;
  v_user_id uuid;
BEGIN
  -- Verify JWT signature (HS256) against Supabase JWT secret.
  -- pgjwt's verify() returns (header, payload, valid). It enforces exp itself
  -- (returns valid=false on expiry) but still returns the parsed payload, so
  -- we can differentiate signature failure from expiry for clearer errors.
  SELECT payload, valid
    INTO v_payload, v_valid
    FROM extensions.verify(p_access_token, current_setting('app.settings.jwt_secret'));

  IF v_valid IS NOT TRUE THEN
    IF v_payload IS NOT NULL
       AND (v_payload->>'exp') IS NOT NULL
       AND (v_payload->>'exp')::integer < extract(epoch FROM now())::integer THEN
      RAISE EXCEPTION 'token_expired' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;

  v_user_id := (v_payload->>'sub')::uuid;

  -- Authorize: user must own character or have corp access.
  IF NOT public.can_user_access_character(v_user_id, p_character_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT * FROM pgmq.read_with_poll(
      'chr_' || p_character_id::text,
      10,            -- vt: visibility timeout (seconds)
      p_qty,
      p_max_seconds,
      250            -- poll_interval_ms
    );
END;
$$;

COMMENT ON FUNCTION public.subscribe_my_events IS
  'Authenticated long-poll read from a per-character pgmq queue. Verifies access_token (Supabase Auth JWT, HS256), checks ownership, returns up to p_qty messages within p_max_seconds. Raises invalid_token / token_expired / forbidden on auth failure.';

-- -----------------------------------------------------------------------------
-- archive_my_events: authenticated archive of consumed messages
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.archive_my_events(
  p_character_id uuid,
  p_access_token text,
  p_msg_ids bigint[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_payload json;
  v_valid boolean;
  v_user_id uuid;
  v_archived integer := 0;
  v_msg_id bigint;
BEGIN
  SELECT payload, valid
    INTO v_payload, v_valid
    FROM extensions.verify(p_access_token, current_setting('app.settings.jwt_secret'));

  IF v_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;

  IF (v_payload->>'exp')::integer < extract(epoch FROM now())::integer THEN
    RAISE EXCEPTION 'token_expired' USING ERRCODE = '42501';
  END IF;

  v_user_id := (v_payload->>'sub')::uuid;

  IF NOT public.can_user_access_character(v_user_id, p_character_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  FOREACH v_msg_id IN ARRAY p_msg_ids LOOP
    IF pgmq.archive('chr_' || p_character_id::text, v_msg_id) THEN
      v_archived := v_archived + 1;
    END IF;
  END LOOP;

  RETURN v_archived;
END;
$$;

COMMENT ON FUNCTION public.archive_my_events IS
  'Authenticated archive of consumed messages from a per-character pgmq queue. Same auth model as subscribe_my_events.';

-- -----------------------------------------------------------------------------
-- Grants: pubsub_client only has EXECUTE on the two auth-gated functions.
-- -----------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.subscribe_my_events(uuid, text, integer, integer) TO pubsub_client;
GRANT EXECUTE ON FUNCTION public.archive_my_events(uuid, text, bigint[]) TO pubsub_client;

-- -----------------------------------------------------------------------------
-- Trigger: create queue on character INSERT
--
-- Covers all character creation paths: register, character_create, ship
-- purchase (corp ships), NPC seeding, world reset. Idempotent — safe to
-- re-run on existing characters.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._tg_ensure_character_queue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
BEGIN
  PERFORM public.ensure_character_queue(NEW.character_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_character_queue ON public.characters;
CREATE TRIGGER trg_ensure_character_queue
  AFTER INSERT ON public.characters
  FOR EACH ROW
  EXECUTE FUNCTION public._tg_ensure_character_queue();

-- -----------------------------------------------------------------------------
-- Backfill: ensure queues exist for every current character.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.characters;
  PERFORM public.ensure_character_queue(character_id) FROM public.characters;
  RAISE NOTICE 'pgmq pubsub: ensured queues for % existing characters', v_count;
END;
$$;
