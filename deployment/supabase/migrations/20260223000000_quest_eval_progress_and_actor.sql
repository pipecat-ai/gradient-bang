-- Quest evaluation: add quest.progress event, resolve actor_character_id for corp ships
--
-- Changes from the original evaluate_quest_progress:
-- 1. Load actor_character_id from events and use COALESCE(actor_character_id, character_id)
--    so corp ship tasks credit the player, not the ship UUID.
-- 2. Emit quest.progress event on partial progress (before step completion)
--    so the client can update progress bars in real time.
-- 3. All player lookups and event emissions use v_player_id instead of v_event.character_id.

CREATE OR REPLACE FUNCTION evaluate_quest_progress(p_event_id BIGINT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event RECORD;
  v_player_id UUID;
  v_sub RECORD;
  v_pq_id UUID;
  v_pq_quest_id UUID;
  v_pq_current_step INT;
  v_pqs_id UUID;
  v_pqs_current_value NUMERIC;
  v_pqs_unique_values JSONB;
  v_row_count INT;
  v_new_value NUMERIC;
  v_unique_val TEXT;
  v_next_step RECORD;
  v_has_next_step BOOLEAN;
  v_quest_code TEXT;
  v_quest_name TEXT;
  v_step_completed_payload JSONB;
BEGIN
  -- 1. Load event
  SELECT id, event_type, character_id, actor_character_id, payload
  INTO v_event
  FROM events
  WHERE id = p_event_id;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_event.character_id IS NULL THEN RETURN; END IF;

  -- Resolve the player who owns quests. For corp ship tasks,
  -- character_id is the ship UUID; actor_character_id is the player.
  v_player_id := COALESCE(v_event.actor_character_id, v_event.character_id);

  -- 2. Find matching step definitions via subscription routing
  FOR v_sub IN
    SELECT qsd.id AS step_id, qsd.quest_id, qsd.step_index,
           qsd.eval_type, qsd.target_value, qsd.payload_filter,
           qsd.aggregate_field, qsd.unique_field, qsd.name AS step_name
    FROM quest_event_subscriptions qes
    JOIN quest_step_definitions qsd ON qsd.id = qes.step_id
    WHERE qes.event_type = v_event.event_type
      AND qsd.enabled = true
  LOOP
    -- 3a. Find active player quest where this step is the CURRENT step
    SELECT pq.id, pq.quest_id, pq.current_step_index,
           pqs.id, pqs.current_value, pqs.unique_values
    INTO v_pq_id, v_pq_quest_id, v_pq_current_step,
         v_pqs_id, v_pqs_current_value, v_pqs_unique_values
    FROM player_quests pq
    JOIN player_quest_steps pqs ON pqs.player_quest_id = pq.id
    WHERE pq.player_id = v_player_id
      AND pq.status = 'active'
      AND pqs.step_id = v_sub.step_id
      AND v_sub.step_index = pq.current_step_index
      AND pqs.completed_at IS NULL;

    IF NOT FOUND THEN CONTINUE; END IF;

    -- 3b. Evaluate payload filter FIRST (before idempotency insert)
    IF NOT evaluate_payload_filter(v_event.payload, v_sub.payload_filter) THEN
      CONTINUE;
    END IF;

    -- 3c. Idempotency check (only after filter passes)
    INSERT INTO quest_progress_events (event_id, player_id, step_id)
    VALUES (p_event_id, v_player_id, v_sub.step_id)
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    IF v_row_count = 0 THEN CONTINUE; END IF;

    -- 3d. Update progress based on eval_type
    v_new_value := v_pqs_current_value;

    CASE v_sub.eval_type
      WHEN 'count', 'count_filtered' THEN
        v_new_value := v_new_value + 1;

      WHEN 'aggregate' THEN
        v_new_value := v_new_value + COALESCE(
          (v_event.payload->>v_sub.aggregate_field)::NUMERIC, 0
        );

      WHEN 'unique_count' THEN
        v_unique_val := v_event.payload->>v_sub.unique_field;
        IF v_unique_val IS NULL THEN
          CONTINUE;
        END IF;
        -- Check if already seen
        IF v_pqs_unique_values @> jsonb_build_array(v_unique_val) THEN
          CONTINUE; -- Already counted this value
        END IF;
        v_new_value := v_new_value + 1;
        -- Append to unique_values
        UPDATE player_quest_steps
        SET unique_values = unique_values || jsonb_build_array(v_unique_val)
        WHERE id = v_pqs_id;
    END CASE;

    -- 3e. Update progress
    UPDATE player_quest_steps
    SET current_value = v_new_value,
        last_event_id = p_event_id
    WHERE id = v_pqs_id;

    -- 3f. Check step completion
    IF v_new_value < v_sub.target_value THEN
      -- Step not yet complete — emit progress update
      PERFORM record_event_with_recipients(
        p_event_type := 'quest.progress',
        p_scope := 'direct',
        p_actor_character_id := v_player_id,
        p_character_id := v_player_id,
        p_payload := jsonb_build_object(
          'quest_id', v_pq_quest_id,
          'step_id', v_sub.step_id,
          'step_index', v_sub.step_index,
          'current_value', v_new_value,
          'target_value', v_sub.target_value
        ),
        p_recipients := ARRAY[v_player_id],
        p_reasons := ARRAY['direct']
      );
    END IF;

    IF v_new_value >= v_sub.target_value THEN
      -- Mark step completed
      UPDATE player_quest_steps
      SET completed_at = now()
      WHERE id = v_pqs_id;

      -- Look up quest name/code for the payload
      SELECT code, name INTO v_quest_code, v_quest_name
      FROM quest_definitions WHERE id = v_pq_quest_id;

      -- Check for next step (save FOUND before PERFORM clobbers it)
      SELECT * INTO v_next_step
      FROM quest_step_definitions
      WHERE quest_id = v_pq_quest_id
        AND step_index = v_pq_current_step + 1
        AND enabled = true;

      v_has_next_step := FOUND;

      -- Build step_completed payload with next step info
      v_step_completed_payload := jsonb_build_object(
        'quest_id', v_pq_quest_id,
        'quest_code', v_quest_code,
        'quest_name', v_quest_name,
        'step_id', v_sub.step_id,
        'step_name', v_sub.step_name,
        'step_index', v_sub.step_index
      );

      IF v_has_next_step THEN
        -- Include next step details so the client can render immediately
        v_step_completed_payload := v_step_completed_payload || jsonb_build_object(
          'next_step', jsonb_build_object(
            'quest_id', v_pq_quest_id,
            'step_id', v_next_step.id,
            'step_index', v_next_step.step_index,
            'name', v_next_step.name,
            'description', v_next_step.description,
            'target_value', v_next_step.target_value,
            'current_value', 0,
            'completed', false,
            'meta', COALESCE(v_next_step.meta, '{}'::jsonb)
          )
        );
      END IF;

      -- Emit step completed event
      PERFORM record_event_with_recipients(
        p_event_type := 'quest.step_completed',
        p_scope := 'direct',
        p_actor_character_id := v_player_id,
        p_character_id := v_player_id,
        p_payload := v_step_completed_payload,
        p_recipients := ARRAY[v_player_id],
        p_reasons := ARRAY['direct']
      );

      IF v_has_next_step THEN
        -- Advance to next step
        UPDATE player_quests
        SET current_step_index = v_pq_current_step + 1
        WHERE id = v_pq_id;

        -- Create player_quest_steps row for next step
        INSERT INTO player_quest_steps (id, player_quest_id, step_id)
        VALUES (gen_random_uuid(), v_pq_id, v_next_step.id);
      ELSE
        -- Final step — quest complete
        UPDATE player_quests
        SET status = 'completed', completed_at = now()
        WHERE id = v_pq_id;

        -- Emit quest completed event
        PERFORM record_event_with_recipients(
          p_event_type := 'quest.completed',
          p_scope := 'direct',
          p_actor_character_id := v_player_id,
          p_character_id := v_player_id,
          p_payload := jsonb_build_object(
            'quest_id', v_pq_quest_id,
            'quest_code', v_quest_code,
            'quest_name', v_quest_name
          ),
          p_recipients := ARRAY[v_player_id],
          p_reasons := ARRAY['direct']
        );
      END IF;
    END IF;

  END LOOP;
END;
$$;
