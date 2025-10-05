"""Tests for server/rpc.py RPC protocol utilities."""

import pytest
from fastapi import HTTPException

import sys
from pathlib import Path

# Add game-server to path for imports
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "game-server"))

from rpc.rpc import rpc_success, rpc_error


class TestRPCSuccess:
    """Test rpc_success function."""

    def test_basic_success(self):
        """Test basic success response formatting."""
        result = rpc_success("test-id-123", "my_status", {"sector": 42})

        assert result["frame_type"] == "rpc"
        assert result["id"] == "test-id-123"
        assert result["endpoint"] == "my_status"
        assert result["ok"] is True
        assert result["result"] == {"sector": 42}

    def test_empty_result(self):
        """Test success with empty result dict."""
        result = rpc_success("id-456", "join", {})

        assert result["ok"] is True
        assert result["result"] == {}

    def test_complex_result(self):
        """Test success with nested result data."""
        complex_data = {
            "character_id": "trader",
            "ship": {"warp_power": 100, "cargo": {"fuel_ore": 50}},
            "sector_contents": {"port": {"code": "BBB"}},
        }
        result = rpc_success("id-789", "my_status", complex_data)

        assert result["result"] == complex_data
        assert result["result"]["ship"]["cargo"]["fuel_ore"] == 50


class TestRPCError:
    """Test rpc_error function."""

    def test_http_exception(self):
        """Test error formatting for HTTPException."""
        exc = HTTPException(status_code=404, detail="Character not found")
        result = rpc_error("error-id-1", "move", exc)

        assert result["frame_type"] == "rpc"
        assert result["id"] == "error-id-1"
        assert result["endpoint"] == "move"
        assert result["ok"] is False
        assert result["error"]["status"] == 404
        assert result["error"]["detail"] == "Character not found"
        assert "code" not in result["error"]

    def test_http_exception_with_code(self):
        """Test error formatting with custom error code."""
        exc = HTTPException(status_code=400, detail="Invalid sector")
        exc.code = "INVALID_SECTOR"
        result = rpc_error("error-id-2", "move", exc)

        assert result["error"]["status"] == 400
        assert result["error"]["code"] == "INVALID_SECTOR"

    def test_generic_exception(self):
        """Test error formatting for generic Exception."""
        exc = ValueError("Something went wrong")
        result = rpc_error("error-id-3", "trade", exc)

        assert result["ok"] is False
        assert result["error"]["status"] == 500
        assert result["error"]["detail"] == "Something went wrong"

    def test_exception_without_code_attribute(self):
        """Test that exceptions without code attribute don't include it."""
        exc = RuntimeError("Runtime error")
        result = rpc_error("error-id-4", "plot_course", exc)

        assert "code" not in result["error"]

    def test_various_status_codes(self):
        """Test different HTTP status codes."""
        test_cases = [
            (400, "Bad Request"),
            (401, "Unauthorized"),
            (403, "Forbidden"),
            (404, "Not Found"),
            (429, "Too Many Requests"),
            (500, "Internal Server Error"),
        ]

        for status_code, detail in test_cases:
            exc = HTTPException(status_code=status_code, detail=detail)
            result = rpc_error(f"id-{status_code}", "test", exc)

            assert result["error"]["status"] == status_code
            assert result["error"]["detail"] == detail
