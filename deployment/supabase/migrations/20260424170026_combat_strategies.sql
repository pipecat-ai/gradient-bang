-- Combat strategies: one row per ship captures the player's authored combat doctrine.
-- Premade templates (balanced / offensive / defensive) reference prompt files on disk;
-- 'custom' stores free-form text in custom_prompt.

CREATE TABLE combat_strategies (
  strategy_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_id             UUID NOT NULL UNIQUE REFERENCES ship_instances(ship_id) ON DELETE CASCADE,
  template            TEXT NOT NULL
                        CHECK (template IN ('balanced', 'offensive', 'defensive', 'custom')),
  custom_prompt       TEXT,
  author_character_id UUID REFERENCES characters(character_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- custom requires a non-empty prompt bounded at 1000 chars; premades must not carry one.
  CONSTRAINT strategy_prompt_matches_template CHECK (
    (template = 'custom'
      AND custom_prompt IS NOT NULL
      AND length(custom_prompt) > 0
      AND length(custom_prompt) <= 1000)
    OR
    (template <> 'custom' AND custom_prompt IS NULL)
  )
);

CREATE INDEX idx_combat_strategies_ship ON combat_strategies(ship_id);
CREATE INDEX idx_combat_strategies_author ON combat_strategies(author_character_id);

CREATE TRIGGER update_combat_strategies_updated_at BEFORE UPDATE ON combat_strategies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE combat_strategies IS 'Per-ship combat doctrine; loaded into LLM context when combat begins';
COMMENT ON COLUMN combat_strategies.template IS 'balanced | offensive | defensive | custom';
COMMENT ON COLUMN combat_strategies.custom_prompt IS 'Free-form doctrine text when template=custom; max 1000 chars';
