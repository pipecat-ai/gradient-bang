-- Add generated column and index for task_id prefix matching
-- Date: 2026-01-19
--
-- This migration adds a generated column to support efficient prefix matching on task_id UUIDs.
-- The Supabase JS client doesn't support ::text casting in filters, so we use a generated column.
-- Enables queries like: WHERE task_id_prefix ILIKE '6c4393%'
-- which allows filtering by short task IDs (first 6 hex chars of UUID).

SET check_function_bodies = OFF;
SET search_path = public;

-- ---------------------------------------------------------------------------
-- 1. Add generated column for task_id prefix (first 12 chars of UUID text)
-- ---------------------------------------------------------------------------
-- Generated column extracts first 12 characters, which covers:
-- - 6-char short IDs (common case)
-- - 8-char IDs (full first segment before first hyphen)
-- - Up to 12-char prefixes for more specific matching

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS task_id_prefix TEXT GENERATED ALWAYS AS (left(task_id::text, 12)) STORED;

COMMENT ON COLUMN public.events.task_id_prefix IS 'First 12 chars of task_id UUID for efficient prefix matching. Auto-generated from task_id.';

-- ---------------------------------------------------------------------------
-- 2. Add index for prefix matching on the generated column
-- ---------------------------------------------------------------------------
-- Uses text_pattern_ops for efficient LIKE/ILIKE prefix queries

CREATE INDEX IF NOT EXISTS idx_events_task_id_prefix
  ON public.events (task_id_prefix text_pattern_ops)
  WHERE task_id_prefix IS NOT NULL;

COMMENT ON INDEX idx_events_task_id_prefix IS 'Index for prefix matching on task_id_prefix. Supports short task ID queries like filter_task_id=6c4393.';
