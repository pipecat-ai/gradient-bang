-- =============================================================================
-- Pubsub character queue lifecycle
-- Date: 2026-05-15
--
-- Pubsub publish failures are now mandatory, so recipient queues must exist
-- before any event fanout can target them. Re-establish the character insert
-- invariant, backfill existing rows, and make record_event_with_recipients
-- self-heal any future queue drift before strict pgmq_publish().
-- =============================================================================

SET check_function_bodies = OFF;
SET search_path = public;

CREATE OR REPLACE FUNCTION public.ensure_character_queue(p_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_qtable text := 'q_chr_' || p_character_id::text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgmq' AND c.relname = v_qtable
  ) THEN
    RETURN;
  END IF;

  PERFORM pgmq.create('chr_' || p_character_id::text);
EXCEPTION
  WHEN duplicate_table THEN
    NULL;
END;
$$;

COMMENT ON FUNCTION public.ensure_character_queue IS
  'Idempotent queue ensure for a character_id.';

REVOKE ALL ON FUNCTION public.ensure_character_queue(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_character_queue(uuid) TO service_role;

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

COMMENT ON FUNCTION public._tg_ensure_character_queue IS
  'Ensures the per-character PGMQ queue exists whenever a character row is inserted.';

REVOKE ALL ON FUNCTION public._tg_ensure_character_queue() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_ensure_character_queue ON public.characters;
CREATE TRIGGER trg_ensure_character_queue
  AFTER INSERT ON public.characters
  FOR EACH ROW
  EXECUTE FUNCTION public._tg_ensure_character_queue();

-- Existing characters may have been created while queue creation was lazy or
-- while pubsub was disabled during a reset. Backfill without purging messages.
SELECT public.ensure_character_queue(character_id)
FROM public.characters;

DO $$
DECLARE
  v_signature regprocedure :=
    'public.record_event_with_recipients(text,text,text,uuid,uuid,integer,uuid,uuid,uuid,jsonb,jsonb,text,uuid[],text[],boolean,uuid)'::regprocedure;
  v_def text;
  v_next text;
  v_old text :=
    '    PERFORM public.pgmq_publish(''chr_'' || v_id::TEXT, v_msg);';
  v_new text :=
    '    PERFORM public.ensure_character_queue(v_id);
    PERFORM public.pgmq_publish(''chr_'' || v_id::TEXT, v_msg);';
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_def;

  IF position(v_new in v_def) > 0 THEN
    RETURN;
  END IF;

  v_next := replace(v_def, v_old, v_new);
  IF v_next = v_def THEN
    RAISE EXCEPTION 'Could not patch record_event_with_recipients queue ensure before pgmq_publish';
  END IF;

  EXECUTE v_next;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts denormalized event rows and publishes the same event to required SQL-owned pubsub delivery. Ensures per-character pgmq queues exist before strict publish; publish failures raise and roll back the event transaction.';
