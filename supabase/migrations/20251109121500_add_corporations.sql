-- Add corporations, membership tables, and ship ownership metadata

-- Corporations mirror the filesystem corporation manager structure
CREATE TABLE corporations (
  corp_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  founder_id UUID NOT NULL REFERENCES characters(character_id) ON DELETE RESTRICT,
  founded TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invite_code TEXT NOT NULL,
  invite_code_generated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invite_code_generated_by UUID REFERENCES characters(character_id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (char_length(trim(name)) > 0)
);

CREATE UNIQUE INDEX idx_corporations_name_lower ON corporations (lower(name));
CREATE INDEX idx_corporations_invite_code ON corporations (invite_code);

CREATE TRIGGER update_corporations_updated_at
  BEFORE UPDATE ON corporations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Characters track their active corporation membership metadata
ALTER TABLE characters
  ADD COLUMN corporation_id UUID REFERENCES corporations(corp_id),
  ADD COLUMN corporation_joined_at TIMESTAMPTZ;

-- Corporation membership ledger storing the canonical member list
CREATE TABLE corporation_members (
  corp_id UUID NOT NULL REFERENCES corporations(corp_id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(character_id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (corp_id, character_id)
);

CREATE INDEX idx_corporation_members_character ON corporation_members(character_id);

-- Corporation ship associations replace the JSON ship list in the legacy storage
CREATE TABLE corporation_ships (
  corp_id UUID NOT NULL REFERENCES corporations(corp_id) ON DELETE CASCADE,
  ship_id UUID NOT NULL REFERENCES ship_instances(ship_id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by UUID REFERENCES characters(character_id) ON DELETE SET NULL,
  PRIMARY KEY (corp_id, ship_id)
);

CREATE INDEX idx_corporation_ships_ship ON corporation_ships(ship_id);

-- Ship ownership metadata now records character, corporation, or unowned states
ALTER TABLE ship_instances
  ALTER COLUMN owner_id DROP NOT NULL,
  ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'character',
  ADD COLUMN acquired TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN became_unowned TIMESTAMPTZ,
  ADD COLUMN former_owner_name TEXT;

ALTER TABLE ship_instances
  ADD COLUMN owner_character_id UUID,
  ADD COLUMN owner_corporation_id UUID;

-- Backfill explicit owner columns so future FK checks succeed
UPDATE ship_instances
SET owner_character_id = owner_id
WHERE owner_type = 'character' AND owner_character_id IS NULL;

ALTER TABLE ship_instances
  ADD CONSTRAINT ship_instances_owner_type_check
  CHECK (owner_type IN ('character', 'corporation', 'unowned'));

ALTER TABLE ship_instances
  ADD CONSTRAINT ship_instances_owner_character_fk
  FOREIGN KEY (owner_character_id) REFERENCES characters(character_id) ON DELETE CASCADE;

ALTER TABLE ship_instances
  ADD CONSTRAINT ship_instances_owner_corporation_fk
  FOREIGN KEY (owner_corporation_id) REFERENCES corporations(corp_id) ON DELETE CASCADE;

ALTER TABLE ship_instances
  ADD CONSTRAINT ship_instances_owner_consistency
  CHECK (
    (owner_type = 'character' AND owner_id IS NOT NULL AND owner_character_id = owner_id AND owner_corporation_id IS NULL)
    OR (owner_type = 'corporation' AND owner_id IS NOT NULL AND owner_corporation_id = owner_id AND owner_character_id IS NULL)
    OR (owner_type = 'unowned' AND owner_id IS NULL AND owner_character_id IS NULL AND owner_corporation_id IS NULL)
  );

CREATE INDEX idx_ship_instances_owner_character
  ON ship_instances(owner_character_id)
  WHERE owner_character_id IS NOT NULL;

CREATE INDEX idx_ship_instances_owner_corporation
  ON ship_instances(owner_corporation_id)
  WHERE owner_corporation_id IS NOT NULL;

-- Initialize acquired timestamps for existing rows
UPDATE ship_instances
SET acquired = COALESCE(created_at, NOW())
WHERE acquired IS NULL;
