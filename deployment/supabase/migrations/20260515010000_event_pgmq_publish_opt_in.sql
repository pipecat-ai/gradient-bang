-- =============================================================================
-- Event PGMQ publish opt-in
-- Date: 2026-05-15
--
-- HTTP polling is the default event delivery path again. Keep the durable
-- events table write unchanged, but skip per-character PGMQ event fanout unless
-- explicitly enabled through app_runtime_config.event_pgmq_publish_enabled.
-- This does not affect the BYOA/subagent bus, which uses the separate bus_*
-- wrapper surface and its own queues.
-- =============================================================================

SET check_function_bodies = OFF;
SET search_path = public;

INSERT INTO public.app_runtime_config (key, value, description)
VALUES (
  'event_pgmq_publish_enabled',
  'false',
  'When true, record_event_with_recipients also publishes per-recipient copies into chr_* PGMQ event queues. Default false because HTTP polling is the supported event delivery path.'
)
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  v_signature regprocedure :=
    'public.record_event_with_recipients(text,text,text,uuid,uuid,integer,uuid,uuid,uuid,jsonb,jsonb,text,uuid[],text[],boolean,uuid)'::regprocedure;
  v_def text;
  v_next text;
  v_var text :=
    '  v_msg JSONB;
  v_event_pgmq_publish_enabled BOOLEAN := FALSE;';
  v_load text :=
    '  SELECT COALESCE(
    (
      SELECT lower(value) IN (''1'', ''true'', ''t'', ''yes'', ''y'', ''on'')
      FROM public.app_runtime_config
      WHERE key = ''event_pgmq_publish_enabled''
    ),
    FALSE
  ) INTO v_event_pgmq_publish_enabled;

';
  v_old_with_ensure text :=
    '    PERFORM public.ensure_character_queue(v_id);
    PERFORM public.pgmq_publish(''chr_'' || v_id::TEXT, v_msg);';
  v_old_without_ensure text :=
    '    PERFORM public.pgmq_publish(''chr_'' || v_id::TEXT, v_msg);';
  v_new text :=
    '    IF v_event_pgmq_publish_enabled THEN
      PERFORM public.ensure_character_queue(v_id);
      PERFORM public.pgmq_publish(''chr_'' || v_id::TEXT, v_msg);
    END IF;';
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_def;

  IF position('v_event_pgmq_publish_enabled BOOLEAN := FALSE;' in v_def) = 0 THEN
    v_next := replace(v_def, '  v_msg JSONB;', v_var);
    IF v_next = v_def THEN
      v_next := replace(v_def, '  v_msg jsonb;', v_var);
    END IF;
    IF v_next = v_def THEN
      RAISE EXCEPTION 'Could not patch record_event_with_recipients event_pgmq_publish_enabled variable';
    END IF;
    v_def := v_next;
  END IF;

  IF position('SELECT COALESCE(' in v_def) = 0
     OR position('event_pgmq_publish_enabled' in split_part(v_def, 'BEGIN', 2)) = 0 THEN
    v_next := replace(v_def, 'BEGIN
  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN', 'BEGIN
' || v_load || '  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN');
    IF v_next = v_def THEN
      RAISE EXCEPTION 'Could not patch record_event_with_recipients event_pgmq_publish_enabled load';
    END IF;
    v_def := v_next;
  END IF;

  IF position('IF v_event_pgmq_publish_enabled THEN' in v_def) = 0 THEN
    v_next := replace(v_def, v_old_with_ensure, v_new);
    IF v_next = v_def THEN
      v_next := replace(v_def, v_old_without_ensure, v_new);
    END IF;
    IF v_next = v_def THEN
      RAISE EXCEPTION 'Could not patch record_event_with_recipients gated pgmq publish';
    END IF;
    v_def := v_next;
  END IF;

  EXECUTE v_def;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts denormalized event rows. Per-character PGMQ event delivery is skipped unless app_runtime_config.event_pgmq_publish_enabled is true; when enabled, publish failures still raise and roll back the event transaction.';
