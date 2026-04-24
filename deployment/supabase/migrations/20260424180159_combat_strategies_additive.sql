-- Combat strategies: make custom_prompt additive.
--
-- The initial design treated template='custom' as a replacement: either the
-- ship ran a premade doctrine OR it used a free-form prompt, never both.
-- The new design layers: the template (balanced / offensive / defensive)
-- always supplies the base doctrine, and `custom_prompt` is optional
-- additional guidance the commander can append to any template.

-- Drop the old "template matches prompt" check (custom ↔ prompt present).
ALTER TABLE combat_strategies
  DROP CONSTRAINT IF EXISTS strategy_prompt_matches_template;

-- Migrate any existing template='custom' rows to 'balanced' (most neutral
-- default) while keeping their custom_prompt intact. No-op on a fresh DB.
UPDATE combat_strategies
  SET template = 'balanced'
  WHERE template = 'custom';

-- Tighten the template check so 'custom' is no longer a valid value.
ALTER TABLE combat_strategies
  DROP CONSTRAINT IF EXISTS combat_strategies_template_check;
ALTER TABLE combat_strategies
  ADD CONSTRAINT combat_strategies_template_check
    CHECK (template IN ('balanced', 'offensive', 'defensive'));

-- custom_prompt stays optional; when present, enforce the 1-1000 char bound.
ALTER TABLE combat_strategies
  ADD CONSTRAINT combat_strategies_custom_prompt_length
    CHECK (
      custom_prompt IS NULL
      OR (length(custom_prompt) > 0 AND length(custom_prompt) <= 1000)
    );

COMMENT ON COLUMN combat_strategies.template IS 'balanced | offensive | defensive — always supplies a base doctrine';
COMMENT ON COLUMN combat_strategies.custom_prompt IS 'Optional additional commander guidance, appended to the template doctrine. Max 1000 chars.';
