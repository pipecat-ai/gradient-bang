from datetime import datetime, timezone

from pipecat.frames.frames import MetricsFrame
from pipecat.metrics.metrics import LLMUsageMetricsData, LLMTokenUsage

from gradientbang.utils.token_usage_logging import TokenUsageCSVLogger, TokenUsageMetricsProcessor


def test_token_usage_logger_writes_header_and_row(tmp_path):
    log_path = tmp_path / "usage.csv"
    logger = TokenUsageCSVLogger(log_path=log_path)
    usage = LLMTokenUsage(
        prompt_tokens=10,
        completion_tokens=5,
        total_tokens=15,
        cache_read_input_tokens=2,
        reasoning_tokens=1,
    )

    logger.log_usage("bot", usage, timestamp=datetime(2025, 1, 1, tzinfo=timezone.utc))

    lines = log_path.read_text().splitlines()
    assert lines[0] == "timestamp,source,input_tokens,cached_tokens,thinking_tokens,output_tokens"
    assert lines[1].split(",")[1:] == ["bot", "10", "2", "1", "5"]


def test_metrics_processor_records_usage(tmp_path):
    log_path = tmp_path / "metrics.csv"
    csv_logger = TokenUsageCSVLogger(log_path=log_path)
    processor = TokenUsageMetricsProcessor(source="task", logger_instance=csv_logger)

    frame = MetricsFrame(
        data=[
            LLMUsageMetricsData(
                processor="llm",
                model="gemini",
                value=LLMTokenUsage(
                    prompt_tokens=3,
                    completion_tokens=4,
                    total_tokens=7,
                    cache_read_input_tokens=1,
                    reasoning_tokens=2,
                ),
            )
        ]
    )

    processor.handle_metrics_frame(frame)

    lines = log_path.read_text().splitlines()
    assert lines[-1].split(",")[1:] == ["task", "3", "1", "2", "4"]
