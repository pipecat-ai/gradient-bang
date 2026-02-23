-- Quest System: tables, functions, trigger
-- Date: 2026-02-20
-- See docs/quest-system-spec.md for full design

SET search_path = public;

-- ============================================================
-- 1. TABLES
-- ============================================================

-- Quest definitions (admin-authored)
CREATE TABLE quest_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  assign_on_creation BOOLEAN NOT NULL DEFAULT false,
  is_repeatable BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE quest_definitions IS 'Top-level quest definitions. Each quest contains sequential sub-quest steps.';
COMMENT ON COLUMN quest_definitions.meta IS 'Client presentation data: quest_giver, reward, icon, etc.';

-- Sequential sub-quest steps within a quest
CREATE TABLE quest_step_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id UUID NOT NULL REFERENCES quest_definitions(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  eval_type TEXT NOT NULL CHECK (eval_type IN ('count', 'count_filtered', 'aggregate', 'unique_count')),
  event_types TEXT[] NOT NULL,
  target_value NUMERIC NOT NULL DEFAULT 1,
  payload_filter JSONB DEFAULT '{}'::jsonb,
  aggregate_field TEXT,
  unique_field TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (quest_id, step_index)
);

COMMENT ON TABLE quest_step_definitions IS 'Sequential sub-quest steps. Players progress through steps in order within a quest.';
COMMENT ON COLUMN quest_step_definitions.meta IS 'Client presentation data: hint, icon, flavor_text, etc.';

-- Event-to-step routing for fast lookup
CREATE TABLE quest_event_subscriptions (
  event_type TEXT NOT NULL,
  step_id UUID NOT NULL REFERENCES quest_step_definitions(id) ON DELETE CASCADE,
  PRIMARY KEY (event_type, step_id)
);

COMMENT ON TABLE quest_event_subscriptions IS 'Maps event types to candidate quest steps. Enables O(1) lookup during event processing.';

-- Player quest state
CREATE TABLE player_quests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES characters(character_id) ON DELETE CASCADE,
  quest_id UUID NOT NULL REFERENCES quest_definitions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'claimed', 'failed')),
  current_step_index INT NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  UNIQUE (player_id, quest_id)
);

COMMENT ON TABLE player_quests IS 'Tracks which quests a player has been assigned and their overall status.';

-- Player quest step progress
CREATE TABLE player_quest_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_quest_id UUID NOT NULL REFERENCES player_quests(id) ON DELETE CASCADE,
  step_id UUID NOT NULL REFERENCES quest_step_definitions(id) ON DELETE CASCADE,
  current_value NUMERIC NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  last_event_id BIGINT,
  unique_values JSONB NOT NULL DEFAULT '[]'::jsonb
);

COMMENT ON TABLE player_quest_steps IS 'Progress on individual sub-quest steps. Only the current step has a row; next step created on completion.';

-- Idempotency tracking
CREATE TABLE quest_progress_events (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  player_id UUID NOT NULL,
  step_id UUID NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quest_progress_events_event_step_unique
    UNIQUE (event_id, player_id, step_id)
);

COMMENT ON TABLE quest_progress_events IS 'Prevents double-application of events to quest progress.';

-- ============================================================
-- 2. INDEXES
-- ============================================================

CREATE INDEX idx_quest_event_subscriptions_event_type
  ON quest_event_subscriptions (event_type);

CREATE INDEX idx_player_quests_player_status
  ON player_quests (player_id, status);

CREATE INDEX idx_player_quest_steps_quest_step
  ON player_quest_steps (player_quest_id, step_id);

CREATE INDEX idx_quest_step_definitions_quest_index
  ON quest_step_definitions (quest_id, step_index);

-- ============================================================
-- 3. RLS POLICIES
-- ============================================================

ALTER TABLE quest_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_step_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_quests ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_quest_steps ENABLE ROW LEVEL SECURITY;

-- Quest definitions are readable by all authenticated users
CREATE POLICY quest_definitions_read ON quest_definitions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY quest_step_definitions_read ON quest_step_definitions
  FOR SELECT TO authenticated USING (true);

-- Players can only read their own quest state
CREATE POLICY player_quests_read ON player_quests
  FOR SELECT TO authenticated
  USING (player_id = auth.uid());

CREATE POLICY player_quest_steps_read ON player_quest_steps
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM player_quests pq
      WHERE pq.id = player_quest_steps.player_quest_id
        AND pq.player_id = auth.uid()
    )
  );

-- Service role gets full access
CREATE POLICY quest_definitions_service ON quest_definitions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY quest_step_definitions_service ON quest_step_definitions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY player_quests_service ON player_quests
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY player_quest_steps_service ON player_quest_steps
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 4. HELPER FUNCTIONS
-- ============================================================

-- Evaluate a payload filter against an event payload.
-- Supports simple equality, _gte, _lte, and _not operators.
CREATE OR REPLACE FUNCTION evaluate_payload_filter(
  p_payload JSONB,
  p_filter JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_key TEXT;
  v_value JSONB;
  v_base_key TEXT;
  v_payload_val TEXT;
BEGIN
  IF p_filter IS NULL OR p_filter = '{}'::jsonb THEN
    RETURN true;
  END IF;

  FOR v_key, v_value IN SELECT * FROM jsonb_each(p_filter)
  LOOP
    IF v_key LIKE '%\_gte' ESCAPE '\' THEN
      v_base_key := left(v_key, length(v_key) - 4);
      v_payload_val := p_payload->>v_base_key;
      IF v_payload_val IS NULL OR v_payload_val::NUMERIC < (v_value #>> '{}')::NUMERIC THEN
        RETURN false;
      END IF;

    ELSIF v_key LIKE '%\_lte' ESCAPE '\' THEN
      v_base_key := left(v_key, length(v_key) - 4);
      v_payload_val := p_payload->>v_base_key;
      IF v_payload_val IS NULL OR v_payload_val::NUMERIC > (v_value #>> '{}')::NUMERIC THEN
        RETURN false;
      END IF;

    ELSIF v_key LIKE '%\_not' ESCAPE '\' THEN
      v_base_key := left(v_key, length(v_key) - 4);
      IF p_payload->v_base_key IS NOT NULL AND p_payload->v_base_key = v_value THEN
        RETURN false;
      END IF;

    ELSE
      -- Simple equality: key must exist and value must match
      IF (p_payload->v_key) IS DISTINCT FROM v_value THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

-- Assign a quest to a player. Creates the player_quests row and
-- the first player_quest_steps row. Returns the player_quest id,
-- or NULL if already assigned (non-repeatable).
CREATE OR REPLACE FUNCTION assign_quest(
  p_player_id UUID,
  p_quest_code TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quest quest_definitions%ROWTYPE;
  v_first_step quest_step_definitions%ROWTYPE;
  v_player_quest_id UUID;
BEGIN
  -- Look up quest
  SELECT * INTO v_quest
  FROM quest_definitions
  WHERE code = p_quest_code AND enabled = true;

  IF NOT FOUND THEN
    RAISE WARNING 'assign_quest: quest not found or not enabled: %', p_quest_code;
    RETURN NULL;
  END IF;

  -- Check if already assigned (for non-repeatable)
  IF NOT v_quest.is_repeatable THEN
    IF EXISTS (
      SELECT 1 FROM player_quests
      WHERE player_id = p_player_id AND quest_id = v_quest.id
    ) THEN
      RETURN NULL; -- Already assigned, skip silently
    END IF;
  END IF;

  -- Find first step
  SELECT * INTO v_first_step
  FROM quest_step_definitions
  WHERE quest_id = v_quest.id AND step_index = 1 AND enabled = true;

  IF NOT FOUND THEN
    RAISE WARNING 'assign_quest: no step_index=1 for quest: %', p_quest_code;
    RETURN NULL;
  END IF;

  -- Create player quest
  v_player_quest_id := gen_random_uuid();
  INSERT INTO player_quests (id, player_id, quest_id, status, current_step_index)
  VALUES (v_player_quest_id, p_player_id, v_quest.id, 'active', 1);

  -- Create first step progress row
  INSERT INTO player_quest_steps (id, player_quest_id, step_id)
  VALUES (gen_random_uuid(), v_player_quest_id, v_first_step.id);

  RETURN v_player_quest_id;
END;
$$;

GRANT EXECUTE ON FUNCTION assign_quest(UUID, TEXT) TO service_role;

-- ============================================================
-- 5. CORE EVALUATION FUNCTION
-- ============================================================

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
    --     This avoids writing a row for events that don't match the filter.
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

-- ============================================================
-- 6. TRIGGER
-- ============================================================

-- Wrapper function for the trigger (triggers cannot call functions
-- with parameters directly, so we wrap it).
CREATE OR REPLACE FUNCTION trigger_evaluate_quest_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Wrapped in exception handler so quest bugs don't break gameplay.
  -- Remove this handler for strict consistency once the quest system is proven.
  BEGIN
    PERFORM evaluate_quest_progress(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'quest_eval_trigger failed for event %: % %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL; -- AFTER trigger, return value is ignored
END;
$$;

-- Fire on every event insert EXCEPT quest events (prevents recursion)
CREATE TRIGGER quest_eval_trigger
  AFTER INSERT ON events
  FOR EACH ROW
  WHEN (NEW.event_type NOT LIKE 'quest.%')
  EXECUTE FUNCTION trigger_evaluate_quest_progress();

-- Quest data is loaded separately via:
--   uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/
