-- Resync missing pieces of 20260306000000_quest_step_rewards.sql
--
-- Some environments had the original version of that migration applied
-- before it was rewritten in place to introduce manual claim. As a result
-- the deployed DB is missing `player_quest_steps.reward_claimed_at` and
-- the `claim_quest_step_reward` function, causing `quest_status` to 500
-- with `column player_quest_steps.reward_claimed_at does not exist`.
--
-- This migration is idempotent and safe to run on databases that already
-- have the correct state (e.g. fresh local dev DBs).

SET search_path = public;

-- ============================================================
-- 1. Add reward_claimed_at column if missing
-- ============================================================

ALTER TABLE player_quest_steps
  ADD COLUMN IF NOT EXISTS reward_claimed_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN player_quest_steps.reward_claimed_at
  IS 'Timestamp when the player claimed the step reward. NULL = unclaimed.';

-- ============================================================
-- 2. Claim function (CREATE OR REPLACE — safe to re-run)
-- ============================================================

CREATE OR REPLACE FUNCTION claim_quest_step_reward(
  p_player_id UUID,
  p_quest_id UUID,
  p_step_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pqs_id UUID;
  v_completed_at TIMESTAMPTZ;
  v_reward_claimed_at TIMESTAMPTZ;
  v_reward_credits INTEGER;
  v_step_name TEXT;
  v_ship_id UUID;
  v_quest_code TEXT;
  v_quest_name TEXT;
BEGIN
  -- 1. Find the player_quest_steps row
  SELECT pqs.id, pqs.completed_at, pqs.reward_claimed_at,
         qsd.reward_credits, qsd.name
  INTO v_pqs_id, v_completed_at, v_reward_claimed_at,
       v_reward_credits, v_step_name
  FROM player_quest_steps pqs
  JOIN player_quests pq ON pq.id = pqs.player_quest_id
  JOIN quest_step_definitions qsd ON qsd.id = pqs.step_id
  WHERE pq.player_id = p_player_id
    AND pq.quest_id = p_quest_id
    AND pqs.step_id = p_step_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'step_not_found');
  END IF;

  -- 2. Validate step is completed
  IF v_completed_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'step_not_completed');
  END IF;

  -- 3. Validate not already claimed
  IF v_reward_claimed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_claimed');
  END IF;

  -- 4. Validate reward exists
  IF v_reward_credits IS NULL OR v_reward_credits <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_reward');
  END IF;

  -- 5. Resolve player's current ship
  SELECT current_ship_id INTO v_ship_id
  FROM characters
  WHERE character_id = p_player_id;

  IF v_ship_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_ship');
  END IF;

  -- 6. Grant reward
  PERFORM update_ship_resources(
    p_ship_id := v_ship_id,
    p_credits_delta := v_reward_credits
  );

  -- 7. Mark claimed
  UPDATE player_quest_steps
  SET reward_claimed_at = now()
  WHERE id = v_pqs_id;

  -- 8. Look up quest info for event
  SELECT code, name INTO v_quest_code, v_quest_name
  FROM quest_definitions WHERE id = p_quest_id;

  -- 9. Emit reward claimed event
  PERFORM record_event_with_recipients(
    p_event_type := 'quest.reward_claimed',
    p_scope := 'direct',
    p_actor_character_id := p_player_id,
    p_character_id := p_player_id,
    p_payload := jsonb_build_object(
      'quest_id', p_quest_id,
      'quest_code', v_quest_code,
      'quest_name', v_quest_name,
      'step_id', p_step_id,
      'step_name', v_step_name,
      'reward', jsonb_build_object('credits', v_reward_credits)
    ),
    p_recipients := ARRAY[p_player_id],
    p_reasons := ARRAY['direct']
  );

  RETURN jsonb_build_object('success', true, 'credits', v_reward_credits);
END;
$$;

GRANT EXECUTE ON FUNCTION claim_quest_step_reward(UUID, UUID, UUID) TO service_role;
