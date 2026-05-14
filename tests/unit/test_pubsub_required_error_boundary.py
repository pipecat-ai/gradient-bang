from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "deployment/supabase/migrations/20260514010000_pubsub_required_error_boundary.sql"
IMMEDIATE_READ_MIGRATION = (
    ROOT / "deployment/supabase/migrations/20260514160000_pubsub_immediate_read.sql"
)
SCOPED_POLLING_MIGRATION = (
    ROOT / "deployment/supabase/migrations/20260514170000_pubsub_scoped_polling.sql"
)
EVENTS_TS = ROOT / "deployment/supabase/functions/_shared/events.ts"
BOT_PY = ROOT / "src/gradientbang/pipecat_server/bot.py"
PUBSUB_PY = ROOT / "src/gradientbang/adapters/events/pubsub.py"


def test_required_pubsub_migration_removes_silent_publish_noop() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    pgmq_publish_body = sql.split("CREATE OR REPLACE FUNCTION public.pgmq_publish", 1)[1].split(
        "COMMENT ON FUNCTION public.pgmq_publish", 1
    )[0]
    assert "undefined_table" not in pgmq_publish_body
    assert "RETURN NULL" not in pgmq_publish_body


def test_required_pubsub_migration_does_not_swallow_pgmq_publish_failures() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    record_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.record_event_with_recipients", 1
    )[1].split("COMMENT ON FUNCTION public.record_event_with_recipients", 1)[0]
    assert "record_event_with_recipients pgmq_publish failed" not in record_body
    assert "PERFORM public.pgmq_publish('chr_' || v_id::TEXT, v_msg);" in record_body


def test_subscribe_my_events_uses_immediate_read_not_wrapped_long_poll() -> None:
    sql = IMMEDIATE_READ_MIGRATION.read_text(encoding="utf-8")

    subscribe_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.subscribe_my_events", 1
    )[1].split("COMMENT ON FUNCTION public.subscribe_my_events", 1)[0]
    assert "read_with_poll" not in subscribe_body
    assert "pgmq.read(" in subscribe_body


def test_pubsub_adapter_caps_legacy_sql_poll_window() -> None:
    source = PUBSUB_PY.read_text(encoding="utf-8")

    assert 'PGMQ_MAX_POLL_SECONDS", "1"' in source
    assert 'PGMQ_EMPTY_POLL_INTERVAL_SECONDS", "1.0"' in source


def test_scoped_pubsub_migration_uses_immediate_reads() -> None:
    sql = SCOPED_POLLING_MIGRATION.read_text(encoding="utf-8")

    assert "read_with_poll" not in sql
    assert "pgmq.read(" in sql
    assert "subscribe_my_events_scope" in sql


def test_scoped_pubsub_migration_verifies_edge_token() -> None:
    sql = SCOPED_POLLING_MIGRATION.read_text(encoding="utf-8")

    assert "app_runtime_config" in sql
    assert "edge_api_token" in sql
    assert "_assert_valid_edge_token" in sql
    assert "invalid_edge_token" in sql


def test_scoped_pubsub_migration_checks_actor_access() -> None:
    sql = SCOPED_POLLING_MIGRATION.read_text(encoding="utf-8")

    subscribe_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.subscribe_my_events_scope", 1
    )[1].split("COMMENT ON FUNCTION public.subscribe_my_events_scope", 1)[0]
    assert "can_actor_access_character" in subscribe_body
    assert "RAISE EXCEPTION 'forbidden'" in subscribe_body


def test_scoped_pubsub_archive_validates_pair_lengths() -> None:
    sql = SCOPED_POLLING_MIGRATION.read_text(encoding="utf-8")

    archive_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.archive_my_events_scope", 1
    )[1].split("COMMENT ON FUNCTION public.archive_my_events_scope", 1)[0]
    assert "array length mismatch" in archive_body
    assert "p_queue_character_ids" in archive_body
    assert "p_msg_ids" in archive_body


def test_emit_error_event_is_log_only() -> None:
    source = EVENTS_TS.read_text(encoding="utf-8")

    emit_error_body = source.split("export async function emitErrorEvent", 1)[1].split(
        "\n}\n", 1
    )[0]
    assert "emitCharacterEvent(" not in emit_error_body
    assert "deprecated_noop" in emit_error_body


def test_bot_purges_bootstrap_echoes_before_activation_and_event_delivery() -> None:
    source = BOT_PY.read_text(encoding="utf-8")

    join_body = source.split("async def _join():", 1)[1].split(
        "except Exception as exc:", 1
    )[0]
    first_purge = join_body.index("await game_client.purge_event_backlog()")
    gather = join_body.index("initial_state = await gather_initial_state")
    second_purge = join_body.rindex("await game_client.purge_event_backlog()")
    start_delivery = join_body.index("await game_client.start_event_delivery()")
    activate = join_body.index("await main_agent.activate_agent(")

    assert first_purge < gather < second_purge < start_delivery < activate
