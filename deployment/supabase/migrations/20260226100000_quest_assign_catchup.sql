-- Quest catch-up: auto-complete steps whose conditions were already met
--
-- Fixes two bugs where quest steps become impossible to complete:
--
-- 1. Player creates a corporation BEFORE receiving tutorial 2 — step 1
--    ("Create or join a corporation") is stuck at current_value=0 forever.
--
-- 2. Player accepts tutorial_corporations BEFORE reaching tutorial 1 step 7
--    ("Accept a contract from the contracts board") — the quest.assigned
--    event is in the past when step 7 becomes current.
--
-- Root causes:
--   a) The events trigger excluded ALL quest.% events, including the safe
--      quest.assigned event needed by tutorial 1 step 7.
--   b) No mechanism existed to replay past events when a new step becomes
--      current (either on assignment or step advance).
--
-- Fix: narrow the events trigger exclusion, and add a lightweight trigger
-- on player_quest_steps that replays matching past events whenever a new
-- step row is created. evaluate_quest_progress is NOT modified.

-- ============================================================
-- 1. Narrow the events trigger to allow quest.assigned through
-- ============================================================

DROP TRIGGER IF EXISTS quest_eval_trigger ON events;

-- Only exclude events emitted by evaluate_quest_progress itself to prevent
-- recursion. quest.assigned is emitted by the quest_assign edge function
-- and is safe to evaluate.
CREATE TRIGGER quest_eval_trigger
  AFTER INSERT ON events
  FOR EACH ROW
  WHEN (NEW.event_type NOT IN (
    'quest.progress',
    'quest.step_completed',
    'quest.completed',
    'quest.status'
  ))
  EXECUTE FUNCTION trigger_evaluate_quest_progress();

-- ============================================================
-- 2. Catch-up trigger on player_quest_steps
-- ============================================================
-- Fires whenever a new step row is created (quest assignment or step
-- advance). Replays past events matching the step's event_types through
-- the existing evaluator. This trigger fires very rarely — only when a
-- quest is assigned or a step completes — so it has zero impact on the
-- events hot path.

CREATE OR REPLACE FUNCTION catch_up_new_quest_step()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_step_event_types TEXT[];
  v_player_id UUID;
  v_catchup_event RECORD;
BEGIN
  -- Load the step's event types
  SELECT event_types INTO v_step_event_types
  FROM quest_step_definitions
  WHERE id = NEW.step_id;

  IF v_step_event_types IS NULL THEN RETURN NULL; END IF;

  -- Get the player
  SELECT player_id INTO v_player_id
  FROM player_quests
  WHERE id = NEW.player_quest_id;

  IF v_player_id IS NULL THEN RETURN NULL; END IF;

  -- Replay matching past events in chronological order
  FOR v_catchup_event IN
    SELECT e.id
    FROM events e
    WHERE (e.character_id = v_player_id OR e.actor_character_id = v_player_id)
      AND e.event_type = ANY(v_step_event_types)
    ORDER BY e.id ASC
    LIMIT 50
  LOOP
    PERFORM evaluate_quest_progress(v_catchup_event.id);
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE TRIGGER quest_step_catchup_trigger
  AFTER INSERT ON player_quest_steps
  FOR EACH ROW
  EXECUTE FUNCTION catch_up_new_quest_step();

-- ============================================================
-- 3. Simplify assign_quest (catch-up now handled by trigger #2)
-- ============================================================

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
      RETURN NULL;
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

  -- Create first step progress row.
  -- The quest_step_catchup_trigger will automatically replay any
  -- matching past events for this step.
  INSERT INTO player_quest_steps (id, player_quest_id, step_id)
  VALUES (gen_random_uuid(), v_player_quest_id, v_first_step.id);

  RETURN v_player_quest_id;
END;
$$;
