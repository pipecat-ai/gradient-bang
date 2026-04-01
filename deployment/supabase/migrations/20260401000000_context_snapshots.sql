-- Context snapshots: metadata for LLM context dumps stored in S3.
-- Used for debugging bot behaviour after the fact.

CREATE TABLE context_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id UUID NOT NULL REFERENCES characters(character_id),
    session_id TEXT NOT NULL,
    snapshot_type TEXT NOT NULL,        -- 'task' or 'voice'
    task_id UUID,                      -- set for task snapshots, NULL for voice
    s3_key TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    snapshot_reason TEXT NOT NULL,      -- 'completion', 'periodic', 'compaction', 'shutdown'
    task_description TEXT,             -- task snapshots only
    task_status TEXT,                  -- task snapshots only: 'completed', 'failed', 'cancelled'
    task_duration_s REAL,             -- task snapshots only
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Voice upsert: one row per s3_key (new key on compaction, overwrite on periodic/shutdown)
CREATE UNIQUE INDEX idx_context_snapshots_s3_key ON context_snapshots(s3_key);

-- Task upsert: one row per task per session.
-- Non-partial so PostgREST can reference it for ON CONFLICT (session_id, task_id).
-- NULLs are distinct in PostgreSQL unique indexes, so voice rows (task_id IS NULL)
-- are unaffected.
CREATE UNIQUE INDEX idx_context_snapshots_task ON context_snapshots(session_id, task_id);

-- Lookup by character
CREATE INDEX idx_context_snapshots_character ON context_snapshots(character_id, created_at DESC);
