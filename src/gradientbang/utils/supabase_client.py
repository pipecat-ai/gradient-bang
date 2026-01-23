"""Supabase-backed AsyncGameClient implementation."""

from __future__ import annotations

import asyncio
import os
import uuid
import logging
from collections import deque
from contextlib import suppress
from typing import Any, Deque, Dict, Mapping, Optional
from pathlib import Path
from datetime import datetime, timezone
import json

import httpx

from gradientbang.utils.api_client import AsyncGameClient as LegacyAsyncGameClient, RPCError
from gradientbang.utils.legacy_ids import canonicalize_character_id


logger = logging.getLogger(__name__)
logger.addHandler(logging.NullHandler())
_TRUE_VALUES = {"1", "true", "on", "yes"}
POLL_INTERVAL_SECONDS = max(0.25, float(os.getenv("SUPABASE_POLL_INTERVAL_SECONDS", "1.0")))
_POLL_LIMIT_ENV = os.getenv("SUPABASE_POLL_LIMIT")
if _POLL_LIMIT_ENV is not None:
    try:
        POLL_LIMIT_DEFAULT = max(1, min(250, int(_POLL_LIMIT_ENV)))
    except ValueError:
        POLL_LIMIT_DEFAULT = 100
else:
    # Cloud: lower default to reduce payload size; local stays at 100
    POLL_LIMIT_DEFAULT = 50 if "supabase.co" in (os.getenv("SUPABASE_URL") or "") else 100
POLL_BACKOFF_MAX = max(1.0, float(os.getenv("SUPABASE_POLL_BACKOFF_MAX", "5.0")))


class AsyncGameClient(LegacyAsyncGameClient):
    """Drop-in replacement that talks to Supabase edge functions via HTTP polling."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        character_id: str,
        transport: str = "websocket",
        actor_character_id: Optional[str] = None,
        entity_type: str = "character",
        allow_corp_actorless_control: bool = False,
        websocket_frame_callback=None,
    ) -> None:
        env_supabase_url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
        input_url = (base_url or env_supabase_url).rstrip("/")

        legacy_hosts = {
            "http://localhost:8000",
            "https://localhost:8000",
            "http://localhost:8002",
            "https://localhost:8002",
        }
        if input_url in legacy_hosts and env_supabase_url:
            input_url = env_supabase_url

        if not input_url:
            raise ValueError("SUPABASE_URL must be provided for Supabase AsyncGameClient")

        supabase_url = input_url.rstrip("/")

        requested_transport = transport.lower()
        if requested_transport not in {"websocket", "supabase"}:
            raise ValueError("Supabase AsyncGameClient transport must be 'supabase'")
        if requested_transport == "websocket":
            requested_transport = "supabase"

        super().__init__(
            base_url=supabase_url,
            character_id=character_id,
            transport="websocket",
            actor_character_id=actor_character_id,
            entity_type=entity_type,
            allow_corp_actorless_control=allow_corp_actorless_control,
            websocket_frame_callback=websocket_frame_callback,
        )

        self._supabase_url = supabase_url
        edge_base = os.getenv("EDGE_FUNCTIONS_URL")
        if edge_base:
            self._functions_url = edge_base.rstrip("/")
        else:
            self._functions_url = f"{self._supabase_url}/functions/v1"
        """
        self._service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not self._service_role_key:
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")
        """
        self._anon_key = os.getenv("SUPABASE_ANON_KEY") or "anon-key"
        self._edge_api_token = (
            os.getenv("EDGE_API_TOKEN")
            or os.getenv("SUPABASE_API_TOKEN")
            or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        )
        if not self._edge_api_token:
            raise ValueError("EDGE_API_TOKEN or SUPABASE_API_TOKEN is required")

        self._http = httpx.AsyncClient(timeout=10.0)
        self._requested_transport = requested_transport

        self._current_sector_id: Optional[int] = None
        self._recent_event_ids: Deque[int] = deque()
        self._recent_event_ids_max = 512
        self._canonical_character_id = canonicalize_character_id(character_id)
        self._canonical_actor_character_id = (
            canonicalize_character_id(actor_character_id)
            if actor_character_id is not None
            else None
        )
        self._event_log_path = os.getenv("SUPABASE_EVENT_LOG_PATH")
        self._poll_interval = POLL_INTERVAL_SECONDS
        self._poll_limit = POLL_LIMIT_DEFAULT
        self._polling_task: Optional[asyncio.Task] = None
        self._polling_stop_event = asyncio.Event()
        self._polling_last_event_id: Optional[int] = None
        self._polling_lock = asyncio.Lock()
        self._polling_backoff = 0.0

    async def close(self):
        await super().close()
        await self._stop_event_poller()
        if self._http:
            await self._http.aclose()
            self._http = None

    async def _ensure_ws(self):  # type: ignore[override]
        return  # Supabase transport does not use legacy websockets

    async def _request(
        self,
        endpoint: str,
        payload: Dict[str, Any],
        *,
        skip_event_delivery: bool = False,
    ) -> Dict[str, Any]:  # type: ignore[override]
        # Skip polling setup only for get_character_jwt (to avoid recursion)
        # For join, we establish polling BEFORE the RPC so join events are received
        if not skip_event_delivery:
            await self._ensure_event_delivery()
        http_client = self._ensure_http_client()

        req_id = str(uuid.uuid4())
        self.last_request_id = req_id  # Track for voice agent request correlation
        enriched = self._inject_character_ids(payload)

        edge_endpoint = endpoint.replace('.', '_')

        response = await http_client.post(
            f"{self._functions_url}/{edge_endpoint}",
            headers=self._edge_headers(),
            json=enriched,
        )

        try:
            data = response.json()
        except ValueError:
            data = {"success": False, "error": response.text or "invalid JSON"}

        success = bool(data.get("success", response.is_success))
        if not success:
            detail = str(data.get("error", response.text or "Unknown error"))
            status = int(data.get("status", response.status_code))
            code = data.get("code")
            error_payload = {"detail": detail, "status": status}
            if code:
                error_payload["code"] = code
            await self._synthesize_error_event(
                endpoint=endpoint,
                request_id=req_id,
                error_payload=error_payload,
            )
            raise RPCError(endpoint, status, detail, code)

        result = {k: v for k, v in data.items() if k != "success"}
        result.setdefault("success", True)
        await self._maybe_synthesize_error_from_result(
            endpoint=endpoint,
            request_id=req_id,
            result=result,
        )
        await self._maybe_update_sector_from_response(endpoint, result)
        return result

    async def _send_command(self, frame: Dict[str, Any]) -> Dict[str, Any]:  # type: ignore[override]
        endpoint = frame.get("endpoint") or frame.get("type")
        if not endpoint:
            raise ValueError("Command frame missing endpoint/type")
        payload = frame.get("payload") or {}
        if not isinstance(payload, dict):
            raise ValueError("Command payload must be a dict")
        return await self._request(endpoint, payload)

    def _edge_headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "apikey": self._anon_key,
            "Authorization": f"Bearer {self._anon_key}",
            "X-API-Token": self._edge_api_token,
        }

    async def ensure_character_jwt(self, force: bool = False) -> str:
        """Ensure a per-character JWT is available (prefetch helper for changefeed rollout)."""
        return await self._ensure_character_jwt(force=force)

    def set_actor_character_id(self, actor_character_id: Optional[str]) -> None:  # type: ignore[override]
        super().set_actor_character_id(actor_character_id)
        self._canonical_actor_character_id = (
            canonicalize_character_id(actor_character_id)
            if actor_character_id is not None
            else None
        )

    async def combat_initiate(
        self,
        *,
        character_id: str,
        target_id: Optional[str] = None,
        target_type: str = "character",
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"character_id": canonicalize_character_id(character_id)}
        if target_id is not None:
            payload["target_id"] = canonicalize_character_id(target_id)
            payload["target_type"] = target_type
        return await self._request("combat_initiate", payload)

    async def combat_action(
        self,
        *,
        combat_id: str,
        action: str,
        commit: int = 0,
        target_id: Optional[str] = None,
        to_sector: Optional[int] = None,
        character_id: str,
        round_number: Optional[int] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "combat_id": combat_id,
            "action": action,
            "character_id": canonicalize_character_id(character_id),
        }
        if commit:
            payload["commit"] = commit
        if target_id is not None:
            payload["target_id"] = canonicalize_character_id(target_id)
        if to_sector is not None:
            payload["destination_sector"] = to_sector
        if round_number is not None:
            payload["round"] = round_number
        return await self._request("combat_action", payload)

    async def combat_leave_fighters(
        self,
        *,
        sector: int,
        quantity: int,
        mode: str = "offensive",
        toll_amount: int = 0,
        character_id: str,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "sector": sector,
            "quantity": quantity,
            "mode": mode,
            "toll_amount": toll_amount,
            "character_id": canonicalize_character_id(character_id),
        }
        return await self._request("combat_leave_fighters", payload)

    async def combat_collect_fighters(
        self,
        *,
        sector: int,
        quantity: int,
        character_id: str,
    ) -> Dict[str, Any]:
        payload = {
            "sector": sector,
            "quantity": quantity,
            "character_id": canonicalize_character_id(character_id),
        }
        return await self._request("combat_collect_fighters", payload)

    async def combat_set_garrison_mode(
        self,
        *,
        sector: int,
        mode: str,
        toll_amount: int = 0,
        character_id: str,
    ) -> Dict[str, Any]:
        payload = {
            "sector": sector,
            "mode": mode,
            "toll_amount": toll_amount,
            "character_id": canonicalize_character_id(character_id),
        }
        return await self._request("combat_set_garrison_mode", payload)

    def _inject_character_ids(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        enriched = dict(payload)
        requested_character_id = enriched.get("character_id")
        if requested_character_id:
            enriched["character_id"] = canonicalize_character_id(
                str(requested_character_id)
            )
        else:
            enriched["character_id"] = self._canonical_character_id

        requested_actor = enriched.get("actor_character_id")
        canonical_actor: Optional[str]
        if requested_actor:
            canonical_actor = canonicalize_character_id(str(requested_actor))
        else:
            canonical_actor = self._canonical_actor_character_id

        if canonical_actor is not None:
            enriched["actor_character_id"] = canonical_actor

        # Auto-inject task_id if set (for TaskAgent task correlation)
        if self._current_task_id and "task_id" not in enriched:
            enriched["task_id"] = self._current_task_id

        return enriched

    async def purchase_fighters(
        self,
        *,
        units: int,
        character_id: str,
    ) -> Dict[str, Any]:
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )
        if not isinstance(units, int) or units <= 0:
            raise ValueError("units must be a positive integer")
        payload = {"character_id": character_id, "units": units}
        return await self._request("purchase_fighters", payload)

    async def recharge_warp_power(
        self,
        units: int,
        character_id: str,
    ) -> Dict[str, Any]:
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )
        payload = {"character_id": character_id, "units": units}
        return await self._request("recharge_warp_power", payload)

    async def transfer_warp_power(
        self,
        *,
        units: int,
        character_id: str,
        to_player_name: Optional[str] = None,
        to_ship_id: Optional[str] = None,
        to_ship_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )
        if not to_player_name and not to_ship_id and not to_ship_name:
            raise ValueError("Must provide to_player_name, to_ship_id, or to_ship_name")
        payload: Dict[str, Any] = {
            "from_character_id": character_id,
            "units": units,
        }
        if to_player_name:
            if not isinstance(to_player_name, str) or not to_player_name.strip():
                raise ValueError("to_player_name must be a non-empty string")
            payload["to_player_name"] = to_player_name
        if to_ship_id:
            if not isinstance(to_ship_id, str) or not to_ship_id.strip():
                raise ValueError("to_ship_id must be a non-empty string")
            payload["to_ship_id"] = to_ship_id
        if to_ship_name:
            if not isinstance(to_ship_name, str) or not to_ship_name.strip():
                raise ValueError("to_ship_name must be a non-empty string")
            payload["to_ship_name"] = to_ship_name
        return await self._request("transfer_warp_power", payload)

    async def transfer_credits(
        self,
        *,
        amount: int,
        character_id: str,
        to_player_name: Optional[str] = None,
        to_ship_id: Optional[str] = None,
        to_ship_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )
        if not to_player_name and not to_ship_id and not to_ship_name:
            raise ValueError("Must provide to_player_name, to_ship_id, or to_ship_name")
        payload: Dict[str, Any] = {
            "from_character_id": character_id,
            "amount": amount,
        }
        if to_player_name:
            if not isinstance(to_player_name, str) or not to_player_name.strip():
                raise ValueError("to_player_name must be a non-empty string")
            payload["to_player_name"] = to_player_name
        if to_ship_id:
            if not isinstance(to_ship_id, str) or not to_ship_id.strip():
                raise ValueError("to_ship_id must be a non-empty string")
            payload["to_ship_id"] = to_ship_id
        if to_ship_name:
            if not isinstance(to_ship_name, str) or not to_ship_name.strip():
                raise ValueError("to_ship_name must be a non-empty string")
            payload["to_ship_name"] = to_ship_name
        return await self._request("transfer_credits", payload)

    async def deposit_to_bank(
        self,
        *,
        amount: int,
        target_player_name: str,
        ship_id: Optional[str] = None,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not isinstance(target_player_name, str) or not target_player_name.strip():
            raise ValueError("target_player_name must be a non-empty string")
        payload: Dict[str, Any] = {
            "direction": "deposit",
            "amount": amount,
            "target_player_name": target_player_name,
        }
        if ship_id:
            payload["ship_id"] = ship_id
        if character_id:
            payload["character_id"] = character_id
        return await self._request("bank_transfer", payload)

    async def withdraw_from_bank(
        self,
        *,
        amount: int,
        character_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if character_id is None:
            character_id = self._character_id
        if character_id != self._character_id:
            raise ValueError(
                f"AsyncGameClient is bound to character_id {self._character_id!r}; "
                f"received {character_id!r}"
            )
        payload = {
            "direction": "withdraw",
            "amount": amount,
            "character_id": character_id,
        }
        return await self._request("bank_transfer", payload)

    async def _emit_frame(self, direction: str, frame: Mapping[str, Any]) -> None:  # type: ignore[override]
        return  # No legacy websocket frames

    async def _ensure_event_delivery(self) -> None:
        await self._ensure_event_poller()

    async def _ensure_event_poller(self) -> None:
        async with self._polling_lock:
            if self._polling_task and not self._polling_task.done():
                return
            if self._polling_task and self._polling_task.done():
                with suppress(Exception):
                    await self._polling_task
                self._polling_task = None
            if self._polling_stop_event.is_set():
                self._polling_stop_event = asyncio.Event()
            if self._polling_last_event_id is None:
                await self._initialize_polling_cursor()
            self._polling_task = asyncio.create_task(self._poll_events_loop())

    async def _initialize_polling_cursor(self) -> None:
        payload = {
            "character_id": self._canonical_character_id,
            "initial_only": True,
        }
        response = await self._request("events_since", payload, skip_event_delivery=True)
        last_id = response.get("last_event_id")
        if isinstance(last_id, int):
            self._polling_last_event_id = last_id
        else:
            self._polling_last_event_id = 0

    async def _poll_events_loop(self) -> None:
        while not self._polling_stop_event.is_set():
            try:
                has_more = await self._poll_events_once()
                self._polling_backoff = 0.0

                # If there are more events available, poll immediately without delay
                if has_more:
                    continue
            except asyncio.CancelledError:
                break
            except Exception:  # noqa: BLE001
                logger.warning("supabase.poller.error", exc_info=True)
                backoff = self._polling_backoff or self._poll_interval
                backoff = min(backoff * 2 if self._polling_backoff else backoff, POLL_BACKOFF_MAX)
                self._polling_backoff = backoff
                try:
                    await asyncio.wait_for(self._polling_stop_event.wait(), timeout=backoff)
                    break
                except asyncio.TimeoutError:
                    continue
            try:
                await asyncio.wait_for(self._polling_stop_event.wait(), timeout=self._poll_interval)
                break
            except asyncio.TimeoutError:
                continue

    async def _poll_events_once(self) -> bool:
        """Poll for events once. Returns True if more events are available."""
        if self._polling_last_event_id is None:
            await self._initialize_polling_cursor()
            return False

        payload = {
            "character_id": self._canonical_character_id,
            "since_event_id": self._polling_last_event_id,
            "limit": self._poll_limit,
        }
        # Basic retry on transient 5xx to avoid stalling long-running tests
        attempts = 3
        backoff = 0.5
        for attempt in range(1, attempts + 1):
            try:
                response = await self._request("events_since", payload, skip_event_delivery=True)
                break
            except RPCError as exc:  # type: ignore
                if exc.status >= 500 and attempt < attempts:
                    await asyncio.sleep(backoff)
                    backoff *= 2
                    continue
                raise
        events = response.get("events")
        if not isinstance(events, list):
            events = []
        for row in events:
            await self._deliver_polled_event(row)
        last_id = response.get("last_event_id")
        if isinstance(last_id, int):
            self._polling_last_event_id = last_id
        elif events:
            maybe = events[-1]
            if isinstance(maybe, Mapping):
                candidate = maybe.get("id")
                if isinstance(candidate, int):
                    self._polling_last_event_id = candidate

        # Return True if there are more events waiting (hit the limit)
        has_more = response.get("has_more")
        return bool(has_more)

    async def _deliver_polled_event(self, row: Mapping[str, Any]) -> None:
        if not isinstance(row, Mapping):
            return
        event_name = row.get("event_type")
        if not isinstance(event_name, str) or not event_name:
            return
        payload = self._build_polled_event_payload(row)

        # Deduplicate events (same as realtime path)
        if not self._record_event_id(payload):
            return

        # Extract request_id from row for event correlation
        request_id = row.get("request_id")

        await self._maybe_update_sector_from_event(event_name, payload)
        await self._process_event(event_name, payload, request_id=request_id)

        # Log events to JSONL audit log (same as realtime path)
        self._append_event_log(event_name, payload)

    def _build_polled_event_payload(self, row: Mapping[str, Any]) -> Dict[str, Any]:
        raw_payload = row.get("payload")
        if isinstance(raw_payload, Mapping):
            payload = dict(raw_payload)
        else:
            payload = {"value": raw_payload}

        meta = row.get("meta")
        if isinstance(meta, Mapping) and "meta" not in payload:
            payload["meta"] = dict(meta)

        # Note: request_id and __event_context should NOT be added to payloads delivered to API consumers
        # These are metadata fields available via separate row fields if needed by internal code
        # Event payloads should only contain application data (request_id belongs in source.request_id if needed)
        return payload

    async def _stop_event_poller(self) -> None:
        # Do one final poll to capture any pending events before stopping
        # This ensures events from the last RPC are delivered before client closes
        try:
            await self._poll_events_once()
        except Exception:
            pass  # Ignore errors during final poll

        self._polling_stop_event.set()
        if self._polling_task is not None:
            self._polling_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._polling_task
            self._polling_task = None

    def _append_event_log(self, event_name: str, payload: Dict[str, Any]) -> None:
        if not self._event_log_path:
            return
        record = {
            "timestamp": payload.get("source", {}).get("timestamp")
            or datetime.now(timezone.utc).isoformat(),
            "event": event_name,
            "payload": payload,
            "corporation_id": payload.get("corp_id"),
        }
        try:
            path = Path(self._event_log_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except (OSError, TypeError) as exc:  # noqa: BLE001
            logger.debug("supabase.event_log.append_failed", exc_info=exc)

    def _ensure_http_client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=10.0)
        return self._http

    async def _maybe_update_sector_from_response(self, endpoint: str, result: Mapping[str, Any]) -> None:
        if not isinstance(result, Mapping):
            return
        sector = result.get("sector")
        sector_id = self._coerce_sector_id_from_value(sector)
        if sector_id is None and endpoint == "move":
            destination = result.get("destination_sector") or result.get("sector_id")
            sector_id = self._coerce_sector_id(destination)
        if sector_id is None and endpoint == "join":
            # join responses sometimes wrap sector under player.sector
            player = result.get("player")
            if isinstance(player, Mapping):
                sector_id = self._coerce_sector_id_from_value(player.get("sector"))
        if sector_id is None:
            return
        self._set_current_sector(sector_id)

    async def _maybe_update_sector_from_event(self, event_name: str, payload: Mapping[str, Any]) -> None:
        sector_id = self._extract_sector_id_from_event(event_name, payload)
        if sector_id is None:
            return
        self._set_current_sector(sector_id)

    def _set_current_sector(self, sector_id: Optional[int]) -> None:
        if sector_id is None:
            return
        super()._set_current_sector(sector_id)
        if sector_id == self._current_sector_id:
            return
        self._current_sector_id = sector_id

    def _extract_sector_id_from_event(self, event_name: str, payload: Mapping[str, Any]) -> Optional[int]:
        ctx = payload.get("__event_context") if isinstance(payload, Mapping) else None
        if isinstance(ctx, Mapping):
            sector_id = self._coerce_sector_id(ctx.get("sector_id"))
            if sector_id is not None:
                return sector_id
        if event_name in {"movement.complete", "status.snapshot", "map.local"}:
            sector = payload.get("sector") if isinstance(payload, Mapping) else None
            sector_id = self._coerce_sector_id_from_value(sector)
            if sector_id is not None:
                return sector_id
        return None

    def _coerce_sector_id_from_value(self, value: Any) -> Optional[int]:
        if isinstance(value, Mapping):
            return self._coerce_sector_id(value.get("id") or value.get("sector_id"))
        return self._coerce_sector_id(value)

    def _coerce_sector_id(self, value: Any) -> Optional[int]:
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().isdigit():
            try:
                return int(value.strip())
            except ValueError:
                return None
        return None

    def _record_event_id(self, payload: Mapping[str, Any]) -> bool:
        ctx = payload.get("__event_context") if isinstance(payload, Mapping) else None
        if not isinstance(ctx, Mapping):
            return True
        event_id = ctx.get("event_id")
        if not isinstance(event_id, int):
            return True
        if event_id in self._recent_event_ids:
            return False
        self._recent_event_ids.append(event_id)
        if len(self._recent_event_ids) > self._recent_event_ids_max:
            self._recent_event_ids.popleft()
        return True

    def _strip_supabase_metadata(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(payload, Mapping):
            return payload  # type: ignore[return-value]
        cleaned = dict(payload)
        cleaned.pop("__event_context", None)
        cleaned.pop("request_id", None)
        return cleaned

    def _extract_event_id_from_payload(self, payload: Mapping[str, Any]) -> Optional[int]:
        ctx = payload.get("__event_context") if isinstance(payload, Mapping) else None
        if not isinstance(ctx, Mapping):
            return None
        event_id = ctx.get("event_id")
        if isinstance(event_id, int):
            return event_id
        return None

    def _format_event(self, event_name: str, payload: Any, request_id: Optional[str] = None) -> Dict[str, Any]:
        # Remove internal tracking metadata before formatting
        if isinstance(payload, dict) and "__supabase_event_id" in payload:
            payload.pop("__supabase_event_id", None)
        # Do NOT add __event_id to the formatted event - it's internal metadata
        event_message = super()._format_event(event_name, payload, request_id=request_id)
        return event_message
