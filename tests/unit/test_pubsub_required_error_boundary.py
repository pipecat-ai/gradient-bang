from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PUBSUB_MIGRATION = ROOT / "deployment/supabase/migrations/20260505000000_pubsub_and_broadcasts.sql"
QUEUE_LIFECYCLE_MIGRATION = (
    ROOT / "deployment/supabase/migrations/20260515000000_pubsub_character_queue_lifecycle.sql"
)
EVENT_PGMQ_GATE_MIGRATION = (
    ROOT / "deployment/supabase/migrations/20260515010000_event_pgmq_publish_opt_in.sql"
)
EVENTS_TS = ROOT / "deployment/supabase/functions/_shared/events.ts"
BOT_PY = ROOT / "src/gradientbang/pipecat_server/bot.py"


def test_pubsub_migration_removes_silent_publish_noop() -> None:
    sql = PUBSUB_MIGRATION.read_text(encoding="utf-8")

    pgmq_publish_body = sql.split("CREATE OR REPLACE FUNCTION public.pgmq_publish", 1)[1].split(
        "COMMENT ON FUNCTION public.pgmq_publish", 1
    )[0]
    assert "undefined_table" not in pgmq_publish_body
    assert "RETURN NULL" not in pgmq_publish_body


def test_pubsub_publish_wrapper_does_not_swallow_failures() -> None:
    sql = PUBSUB_MIGRATION.read_text(encoding="utf-8")

    pgmq_publish_body = sql.split("CREATE OR REPLACE FUNCTION public.pgmq_publish", 1)[1].split(
        "COMMENT ON FUNCTION public.pgmq_publish", 1
    )[0]
    assert "EXCEPTION" not in pgmq_publish_body
    assert "pgmq.send" in pgmq_publish_body


def test_event_pgmq_publish_gate_defaults_false() -> None:
    sql = EVENT_PGMQ_GATE_MIGRATION.read_text(encoding="utf-8")

    assert "'event_pgmq_publish_enabled'" in sql
    assert "'false'" in sql
    assert "ON CONFLICT (key) DO NOTHING" in sql


def test_event_pgmq_publish_gate_wraps_per_character_publish() -> None:
    sql = EVENT_PGMQ_GATE_MIGRATION.read_text(encoding="utf-8")

    assert "v_event_pgmq_publish_enabled BOOLEAN := FALSE" in sql
    assert "WHERE key = ''event_pgmq_publish_enabled''" in sql
    assert "IF v_event_pgmq_publish_enabled THEN" in sql
    assert "PERFORM public.ensure_character_queue(v_id);" in sql
    assert "PERFORM public.pgmq_publish(''chr_'' || v_id::TEXT, v_msg);" in sql
    assert sql.index("IF v_event_pgmq_publish_enabled THEN") < sql.rindex(
        "PERFORM public.pgmq_publish(''chr_'' || v_id::TEXT, v_msg);"
    )


def test_queue_lifecycle_migration_restores_character_insert_trigger() -> None:
    sql = QUEUE_LIFECYCLE_MIGRATION.read_text(encoding="utf-8")

    assert "CREATE OR REPLACE FUNCTION public._tg_ensure_character_queue()" in sql
    assert "PERFORM public.ensure_character_queue(NEW.character_id);" in sql
    assert "CREATE TRIGGER trg_ensure_character_queue" in sql
    assert "AFTER INSERT ON public.characters" in sql


def test_queue_lifecycle_migration_backfills_existing_characters() -> None:
    sql = QUEUE_LIFECYCLE_MIGRATION.read_text(encoding="utf-8")

    assert "SELECT public.ensure_character_queue(character_id)" in sql
    assert "FROM public.characters" in sql
    assert "pgmq.purge_queue" not in sql


def test_queue_lifecycle_migration_ensures_queue_before_publish() -> None:
    sql = QUEUE_LIFECYCLE_MIGRATION.read_text(encoding="utf-8")
    ensure = "PERFORM public.ensure_character_queue(v_id);"
    publish = "PERFORM public.pgmq_publish(''chr_'' || v_id::TEXT, v_msg);"

    assert ensure in sql
    assert publish in sql
    assert sql.index(ensure) < sql.rindex(publish)
    assert "position(v_new in v_def) > 0" in sql
    assert "Could not patch record_event_with_recipients" in sql


def test_subscribe_my_events_uses_immediate_read_not_wrapped_long_poll() -> None:
    sql = PUBSUB_MIGRATION.read_text(encoding="utf-8")

    subscribe_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.subscribe_my_events", 1
    )[1].split("COMMENT ON FUNCTION public.subscribe_my_events", 1)[0]
    assert "read_with_poll" not in subscribe_body
    assert "pgmq.read(" in subscribe_body


def test_scoped_pubsub_migration_uses_immediate_reads() -> None:
    sql = PUBSUB_MIGRATION.read_text(encoding="utf-8")

    subscribe_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.subscribe_my_events_scope", 1
    )[1].split("COMMENT ON FUNCTION public.subscribe_my_events_scope", 1)[0]
    assert "read_with_poll" not in subscribe_body
    assert "pgmq.read(" in subscribe_body


def test_scoped_pubsub_migration_verifies_edge_token() -> None:
    sql = PUBSUB_MIGRATION.read_text(encoding="utf-8")

    assert "app_runtime_config" in sql
    assert "edge_api_token" in sql
    assert "_assert_valid_edge_token" in sql
    assert "invalid_edge_token" in sql


def test_scoped_pubsub_migration_checks_actor_access() -> None:
    sql = PUBSUB_MIGRATION.read_text(encoding="utf-8")

    subscribe_body = sql.split(
        "CREATE OR REPLACE FUNCTION public.subscribe_my_events_scope", 1
    )[1].split("COMMENT ON FUNCTION public.subscribe_my_events_scope", 1)[0]
    assert "can_actor_access_character" in subscribe_body
    assert "RAISE EXCEPTION 'forbidden'" in subscribe_body


def test_scoped_pubsub_archive_validates_pair_lengths() -> None:
    sql = PUBSUB_MIGRATION.read_text(encoding="utf-8")

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
