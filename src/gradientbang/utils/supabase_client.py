"""Supabase-backed AsyncGameClient implementation."""

from __future__ import annotations

import os
import uuid
import logging
from typing import Any, Dict, Mapping, Optional
from pathlib import Path
from datetime import datetime, timezone
import json

import time

import httpx

from gradientbang.adapters.events import make_event_adapter
from gradientbang.utils.api_client import AsyncGameClient as BaseAsyncGameClient, RPCError
from gradientbang.utils.legacy_ids import canonicalize_character_id


logger = logging.getLogger(__name__)
logger.addHandler(logging.NullHandler())
_TRUE_VALUES = {"1", "true", "on", "yes"}


class AsyncGameClient(BaseAsyncGameClient):
    """Drop-in replacement that talks to Supabase edge functions via HTTP polling."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        character_id: str,
        transport: str = "supabase",
        actor_character_id: Optional[str] = None,
        entity_type: str = "character",
        allow_corp_actorless_control: bool = False,
        enable_event_polling: bool = True,
        websocket_frame_callback=None,
    ) -> None:
        env_supabase_url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
        input_url = (base_url or env_supabase_url).rstrip("/")

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
            transport="supabase",
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

        self._canonical_character_id = canonicalize_character_id(character_id)
        self._canonical_actor_character_id = (
            canonicalize_character_id(actor_character_id)
            if actor_character_id is not None
            else None
        )
        self._event_log_path = os.getenv("SUPABASE_EVENT_LOG_PATH")
        self._enable_event_polling = enable_event_polling

        # Event-delivery adapter. Polling-related state (scope, cursor, dedup
        # ring, task lifecycle) lives inside the adapter — see
        # ``gradientbang.adapters.events`` for the Protocol and the polling
        # implementation. The factory currently always returns the polling
        # adapter; the upcoming pubsub PR will branch on EVENT_TRANSPORT here.
        self._event_adapter = make_event_adapter(self)

    def set_event_polling_scope(
        self,
        *,
        character_ids: Optional[list[str]] = None,
        corp_id: Optional[str] = None,
        ship_ids: Optional[list[str]] = None,
    ) -> None:
        """Update the event subscription scope (delegates to the adapter).

        Public name preserved for backward compatibility with VoiceAgent /
        EventRelay callers; the underlying transport is the adapter.
        """
        self._event_adapter.set_scope(
            character_ids=character_ids,
            corp_id=corp_id,
            ship_ids=ship_ids,
        )

    async def close(self):
        await super().close()
        await self._event_adapter.stop()
        if self._http:
            await self._http.aclose()
            self._http = None

    async def _ensure_ws(self):  # type: ignore[override]
        return  # Supabase transport does not use legacy websockets

    async def identify(self, *, name: Optional[str] = None, character_id: Optional[str] = None):  # type: ignore[override]
        """No-op for Supabase transport (identify is legacy websocket-only)."""
        return None

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
        if "request_id" not in enriched:
            enriched["request_id"] = req_id

        edge_endpoint = endpoint.replace('.', '_')

        url = f"{self._functions_url}/{edge_endpoint}"
        t0 = time.monotonic()
        response = await http_client.post(
            url,
            headers=self._edge_headers(),
            json=enriched,
        )
        elapsed_ms = (time.monotonic() - t0) * 1000
        from loguru import logger as _loguru
        if edge_endpoint != "events_since":
            _loguru.info(f"API {url} {response.status_code} {elapsed_ms:.0f}ms")

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
            cleaned_target = target_id.strip()
            if cleaned_target:
                # Combat targets can be combatant IDs, ship IDs, or display labels;
                # do not force UUID canonicalization here.
                payload["target_id"] = cleaned_target
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
            cleaned_target = target_id.strip()
            if cleaned_target:
                # Preserve raw target labels/IDs; server resolves to combatant_id.
                payload["target_id"] = cleaned_target
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

    async def combat_disband_garrison(
        self,
        *,
        sector: int,
        character_id: str,
    ) -> Dict[str, Any]:
        payload = {
            "sector": sector,
            "character_id": canonicalize_character_id(character_id),
        }
        return await self._request("combat_disband_garrison", payload)

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
        ship_name: Optional[str] = None,
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
        if ship_name:
            if not isinstance(ship_name, str) or not ship_name.strip():
                raise ValueError("ship_name must be a non-empty string")
            payload["ship_name"] = ship_name
        if (ship_id or ship_name) and "actor_character_id" not in payload:
            payload["actor_character_id"] = self._actor_character_id or self._character_id
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
        if not self._enable_event_polling:
            return
        await self._event_adapter.start()

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
        # Ownership guard: only mutate from events about the bound character.
        # The shared client polls corp-ship events (for bus fanout); their
        # sector data must not clobber the bound character's cached sector.
        # Compare against the canonical id — server events carry canonical UUIDs
        # while ``self._character_id`` may be a legacy label in dev mode.
        player = payload.get("player") if isinstance(payload, Mapping) else None
        if not isinstance(player, Mapping):
            return
        player_id = player.get("id")
        if not isinstance(player_id, str) or player_id != self._canonical_character_id:
            return

        sector_id = self._extract_sector_id_from_event(event_name, payload)
        if sector_id is None:
            return
        self._set_current_sector(sector_id)

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


__all__ = ["AsyncGameClient", "RPCError"]
