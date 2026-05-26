from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PUBSUB_MIGRATION = ROOT / "deployment/supabase/migrations/20260505000000_pubsub_and_broadcasts.sql"
SESSION_PUBSUB_MIGRATION = (
    ROOT / "deployment/supabase/migrations/20260515020000_session_scoped_event_pubsub.sql"
)
EVENTS_TS = ROOT / "deployment/supabase/functions/_shared/events.ts"
ORCHESTRATOR_PY = ROOT / "src/gradientbang/runtime/orchestrator.py"
BUS_MIGRATION = ROOT / "deployment/supabase/migrations/20260512000000_byoa_infrastructure.sql"


def test_session_pubsub_migration_creates_session_table_and_indexes() -> None:
    sql = SESSION_PUBSUB_MIGRATION.read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS public.event_sessions" in sql
    assert "session_id uuid PRIMARY KEY" in sql
    assert "queue_name text UNIQUE NOT NULL" in sql
    assert "expires_at timestamptz NOT NULL" in sql
    assert "idx_event_sessions_expires_at" in sql
    assert "USING gin (scope_character_ids)" in sql


def test_session_pubsub_migration_adds_required_wrappers() -> None:
    sql = SESSION_PUBSUB_MIGRATION.read_text(encoding="utf-8")

    for fn in (
        "event_session_register",
        "event_session_heartbeat",
        "event_session_update_scope",
        "event_session_subscribe",
        "event_session_archive",
        "event_session_unregister",
        "event_session_cleanup",
        "event_session_publish",
        "_validate_event_session_corp",
    ):
        assert f"FUNCTION public.{fn}" in sql


def test_session_cleanup_is_database_owned_batched_and_lock_safe() -> None:
    sql = SESSION_PUBSUB_MIGRATION.read_text(encoding="utf-8")
    cleanup_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.event_session_cleanup", 1
    )[1].split("COMMENT ON FUNCTION public.event_session_cleanup", 1)[0]

    assert "pg_try_advisory_lock(hashtext('event_session_cleanup'))" in cleanup_body
    assert "FOR UPDATE SKIP LOCKED" in cleanup_body
    assert "LIMIT v_limit" in cleanup_body
    assert "pgmq.drop_queue" in cleanup_body
    assert "expires_at <= now()" in cleanup_body
    assert "cron.schedule" in sql
    assert "'event-session-cleanup'" in sql


def test_session_publish_only_targets_active_sessions() -> None:
    sql = SESSION_PUBSUB_MIGRATION.read_text(encoding="utf-8")
    publish_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.event_session_publish", 1
    )[1].split("COMMENT ON FUNCTION public.event_session_publish", 1)[0]

    assert "expires_at > now()" in publish_body
    assert "hard_expires_at > now()" in publish_body
    assert "scope_character_ids && COALESCE(p_recipient_ids" in publish_body
    assert "corp_id = p_corp_id" in publish_body
    assert "COALESCE(p_is_broadcast, false)" in publish_body
    assert "undefined_table" in publish_body
    assert "DELETE FROM public.event_sessions" in publish_body


def test_session_register_and_scope_update_validate_corp_access() -> None:
    sql = SESSION_PUBSUB_MIGRATION.read_text(encoding="utf-8")

    assert "_validate_event_session_corp(p_actor_character_id, p_corp_id)" in sql
    assert "_validate_event_session_corp(v_actor_character_id, p_corp_id)" in sql
    assert "RAISE EXCEPTION 'forbidden'" in sql


def test_record_event_is_patched_away_from_chr_queue_publish() -> None:
    sql = SESSION_PUBSUB_MIGRATION.read_text(encoding="utf-8")

    assert "event_session_publish" in sql
    assert "PERFORM public.event_session_publish" in sql
    assert "Could not patch record_event_with_recipients for session-scoped pubsub" in sql


def test_pgmq_publish_wrapper_does_not_swallow_failures() -> None:
    sql = PUBSUB_MIGRATION.read_text(encoding="utf-8")

    pgmq_publish_body = sql.split("CREATE OR REPLACE FUNCTION public.pgmq_publish", 1)[1].split(
        "COMMENT ON FUNCTION public.pgmq_publish", 1
    )[0]
    assert "undefined_table" not in pgmq_publish_body
    assert "RETURN NULL" not in pgmq_publish_body


def test_session_wrappers_verify_edge_token() -> None:
    sql = SESSION_PUBSUB_MIGRATION.read_text(encoding="utf-8")

    assert "_assert_valid_edge_token" in sql
    assert "event_session_register" in sql
    assert "event_session_subscribe" in sql
    assert "event_session_archive" in sql


def test_emit_error_event_is_log_only() -> None:
    source = EVENTS_TS.read_text(encoding="utf-8")

    emit_error_body = source.split("export async function emitErrorEvent", 1)[1].split(
        "\n}\n", 1
    )[0]
    assert "emitCharacterEvent(" not in emit_error_body
    assert "deprecated_noop" in emit_error_body


def test_bot_session_queue_bootstrap_order_and_catchup_replay() -> None:
    source = ORCHESTRATOR_PY.read_text(encoding="utf-8")

    join_body = source.split("async def join(self) -> None:", 1)[1].split(
        "async def _emit_client_event", 1
    )[0]
    prepare = join_body.index("await self.game_client.prepare_event_delivery_for_bootstrap()")
    gather = join_body.index("initial_state = await gather_initial_state")
    complete = join_body.index("await self.game_client.complete_event_delivery_bootstrap()")
    inject_messages = join_body.index("await self.voice_worker.queue_frames")
    replay = join_body.index("await self.game_client.replay_event_delivery_catchup()")
    start_delivery = join_body.index("await self.game_client.start_event_delivery()")

    assert prepare < gather < complete < inject_messages < replay < start_delivery


def test_bus_migration_still_owns_only_bus_wrappers() -> None:
    sql = BUS_MIGRATION.read_text(encoding="utf-8")

    for fn in ("bus_join", "bus_publish", "bus_subscribe", "bus_archive", "bus_leave"):
        assert f"FUNCTION public.{fn}" in sql
    assert "event_sessions" not in sql
    assert "record_event_with_recipients" not in sql
