"""Tests for the PendingRequests correlation helper."""

import asyncio

import pytest

from gradientbang.pipecat_server.subagents.bus_correlation import (
    PendingRequests,
    PendingRequestsClosedError,
)


@pytest.mark.unit
class TestIssueResolve:
    @pytest.mark.asyncio
    async def test_resolve_returns_result(self):
        pending = PendingRequests()

        async def resolve_soon():
            await asyncio.sleep(0)
            pending.resolve("c1", {"value": 42})

        # Plain create_task (not TaskGroup) so exceptions from issue()
        # propagate directly instead of being wrapped in ExceptionGroup.
        resolver = asyncio.create_task(resolve_soon())
        try:
            result = await pending.issue("c1", timeout=1.0)
        finally:
            await resolver
        assert result == {"value": 42}
        assert len(pending) == 0  # entry removed after settle

    @pytest.mark.asyncio
    async def test_reject_raises_runtime_error(self):
        pending = PendingRequests()

        async def reject_soon():
            await asyncio.sleep(0)
            pending.reject("c1", "boom")

        rejector = asyncio.create_task(reject_soon())
        try:
            with pytest.raises(RuntimeError, match="boom"):
                await pending.issue("c1", timeout=1.0)
        finally:
            await rejector
        assert len(pending) == 0

    @pytest.mark.asyncio
    async def test_timeout_raises_and_clears_entry(self):
        pending = PendingRequests()
        with pytest.raises(asyncio.TimeoutError):
            await pending.issue("c1", timeout=0.01)
        assert len(pending) == 0

    @pytest.mark.asyncio
    async def test_late_resolve_is_silent_no_op(self):
        pending = PendingRequests()
        with pytest.raises(asyncio.TimeoutError):
            await pending.issue("c1", timeout=0.01)
        # After timeout, nothing is pending. A late resolve returns False
        # and does not raise.
        assert pending.resolve("c1", {"value": "stale"}) is False

    @pytest.mark.asyncio
    async def test_duplicate_correlation_id_rejected(self):
        pending = PendingRequests()

        async def hold():
            try:
                await pending.issue("c1", timeout=1.0)
            except Exception:
                pass

        holder = asyncio.create_task(hold())
        try:
            await asyncio.sleep(0)  # let the first issue register
            with pytest.raises(RuntimeError, match="already in flight"):
                await pending.issue("c1", timeout=1.0)
            pending.resolve("c1", {"ok": True})
        finally:
            await holder


@pytest.mark.unit
class TestConcurrency:
    @pytest.mark.asyncio
    async def test_two_concurrent_in_flight_resolve_independently(self):
        pending = PendingRequests()

        async def resolve_pair():
            await asyncio.sleep(0)
            pending.resolve("c2", {"v": "two"})
            pending.resolve("c1", {"v": "one"})

        resolver = asyncio.create_task(resolve_pair())
        try:
            results = await asyncio.gather(
                pending.issue("c1", timeout=1.0),
                pending.issue("c2", timeout=1.0),
            )
        finally:
            await resolver
        assert results == [{"v": "one"}, {"v": "two"}]
        assert len(pending) == 0


@pytest.mark.unit
class TestCancelAll:
    @pytest.mark.asyncio
    async def test_cancel_all_cancels_pending_futures(self):
        pending = PendingRequests()
        errors: list[BaseException] = []

        async def hold(cid: str):
            try:
                await pending.issue(cid, timeout=10.0)
            except BaseException as exc:
                errors.append(exc)

        holders = [
            asyncio.create_task(hold("c1")),
            asyncio.create_task(hold("c2")),
        ]
        try:
            await asyncio.sleep(0)  # let both register
            cancelled = pending.cancel_all("shutdown")
            await asyncio.gather(*holders)
        finally:
            for h in holders:
                if not h.done():
                    h.cancel()

        assert cancelled == 2
        assert len(errors) == 2
        for exc in errors:
            assert isinstance(exc, asyncio.CancelledError)

    @pytest.mark.asyncio
    async def test_issue_after_cancel_all_raises_closed(self):
        pending = PendingRequests()
        pending.cancel_all("shutdown")
        with pytest.raises(PendingRequestsClosedError):
            await pending.issue("c1", timeout=1.0)

    @pytest.mark.asyncio
    async def test_cancel_all_idempotent(self):
        pending = PendingRequests()
        assert pending.cancel_all("first") == 0
        assert pending.cancel_all("second") == 0  # no double-cancel side effects


@pytest.mark.unit
class TestLateMessages:
    """Late or mismatched responses must not crash the helper."""

    @pytest.mark.asyncio
    async def test_resolve_unknown_id_returns_false(self):
        pending = PendingRequests()
        assert pending.resolve("never-issued", {"x": 1}) is False

    @pytest.mark.asyncio
    async def test_reject_unknown_id_returns_false(self):
        pending = PendingRequests()
        assert pending.reject("never-issued", "error") is False
