"""Supabase-backed AsyncGameClient implementation."""

from __future__ import annotations

import os
import uuid
import logging
from typing import Any, Dict, Mapping, Optional

import httpx

from utils.api_client import AsyncGameClient as LegacyAsyncGameClient, RPCError
from utils.legacy_ids import canonicalize_character_id
from utils.supabase_realtime import SupabaseRealtimeListener


logger = logging.getLogger(__name__)
logger.addHandler(logging.NullHandler())
SUPABASE_REALTIME_DEBUG = os.getenv("SUPABASE_REALTIME_DEBUG", "").lower() in {
    "1",
    "true",
    "on",
}
# Enable verbose realtime logging by exporting SUPABASE_REALTIME_DEBUG=1
logger.setLevel(logging.INFO if SUPABASE_REALTIME_DEBUG else logging.WARNING)


class AsyncGameClient(LegacyAsyncGameClient):
    """Drop-in replacement that talks to Supabase edge functions + Realtime."""

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
        self._service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not self._service_role_key:
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")
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

        self._realtime_listener: Optional[SupabaseRealtimeListener] = None
        self._realtime_subscribe_timeout = float(
            os.getenv("SUPABASE_REALTIME_SUBSCRIBE_TIMEOUT", "5")
        )
        self._canonical_character_id = canonicalize_character_id(character_id)
        self._canonical_actor_character_id = (
            canonicalize_character_id(actor_character_id)
            if actor_character_id is not None
            else None
        )

    async def close(self):
        await super().close()
        if self._http:
            await self._http.aclose()
            self._http = None
        if self._realtime_listener is not None:
            await self._realtime_listener.stop()
            self._realtime_listener = None

    async def _ensure_ws(self):  # type: ignore[override]
        return  # Supabase transport does not use legacy websockets

    async def _request(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:  # type: ignore[override]
        await self._ensure_realtime_listener()

        req_id = str(uuid.uuid4())
        enriched = self._inject_character_ids(payload)

        response = await self._http.post(
            f"{self._functions_url}/{endpoint}",
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

        return enriched

    async def _emit_frame(self, direction: str, frame: Mapping[str, Any]) -> None:  # type: ignore[override]
        return  # No legacy websocket frames

    def _character_topic(self) -> str:
        return f"public:character:{self._canonical_character_id}"

    async def _ensure_realtime_listener(self) -> None:
        if self._realtime_listener is None:
            listener = SupabaseRealtimeListener(
                supabase_url=self._supabase_url,
                anon_key=self._anon_key,
                topic=self._character_topic(),
                subscribe_timeout=self._realtime_subscribe_timeout,
            )
            listener.on_any(self._handle_realtime_event)
            self._realtime_listener = listener

        await self._realtime_listener.start()

    async def _handle_realtime_event(
        self,
        event_name: str,
        payload: Dict[str, Any],
    ) -> None:
        logger.info(
            "supabase realtime event received",
            extra={
                "event": event_name,
                "payload_keys": list(payload.keys()),
            },
        )
        await self._process_event(event_name, payload)
