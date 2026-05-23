"""Supabase-backed AsyncGameClient implementation."""

from __future__ import annotations

import contextlib
import contextvars
import uuid
import logging
from typing import Any, Dict, Iterator, Mapping, Optional
from pathlib import Path
from datetime import datetime, timezone
import json

import time

import httpx

from gradientbang.config import settings
from gradientbang.game.api_client import BaseAsyncGameClient, RPCError
from gradientbang.game.transport import make_event_adapter
from gradientbang.game.transport.base import EventAdapter
from gradientbang.utils.legacy_ids import canonicalize_character_id


logger = logging.getLogger(__name__)


# Per-call task_id override. The Phase 1 broker tags the task_id on
# every brokered RPC. The shared ``self._current_task_id`` instance
# field would race if two concurrent broker handlers wrote to it
# between set and read (each ``_request`` ``await``s before
# ``_inject_character_ids`` runs). A ContextVar is async-safe — each
# asyncio Task carries its own copy of the context — so handler A and
# handler B can run concurrently without cross-pollution.
_per_call_task_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "gb_supabase_per_call_task_id", default=None
)
_per_call_character_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "gb_supabase_per_call_character_id", default=None
)
_per_call_actor_character_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "gb_supabase_per_call_actor_character_id", default=None
)


@contextlib.contextmanager
def per_call_task_id(task_id: Optional[str]) -> Iterator[None]:
    """Bind ``task_id`` for the duration of a brokered RPC.

    The Supabase client's ``_inject_character_ids`` reads this and
    enriches the outbound payload with the override. Outside the
    block, payloads fall back to the client's ``current_task_id`` (or
    nothing). Safe under concurrent broker dispatch.
    """
    token = _per_call_task_id.set(task_id)
    try:
        yield
    finally:
        _per_call_task_id.reset(token)


@contextlib.contextmanager
def per_call_identity(
    character_id: Optional[str],
    actor_character_id: Optional[str] = None,
) -> Iterator[None]:
    """Bind authoritative per-call identity for brokered RPC payloads.

    The broker should not pass identity through heterogeneous method
    signatures. Instead, ``_inject_character_ids`` reads these ContextVars at
    the transport boundary and overwrites any payload identity fields with the
    envelope values for the current asyncio Task.
    """
    character_token = _per_call_character_id.set(character_id)
    actor_token = _per_call_actor_character_id.set(actor_character_id)
    try:
        yield
    finally:
        _per_call_actor_character_id.reset(actor_token)
        _per_call_character_id.reset(character_token)


logger.addHandler(logging.NullHandler())
_TRUE_VALUES = {"1", "true", "on", "yes"}


class AsyncGameClient(BaseAsyncGameClient):
    """Client that talks to Supabase edge functions over HTTP."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        character_id: str,
        functions_url: Optional[str] = None,
        actor_character_id: Optional[str] = None,
        entity_type: str = "character",
        allow_corp_actorless_control: bool = False,
        enable_event_polling: bool = True,
        access_token: Optional[str] = None,
    ) -> None:
        env_supabase_url = (settings.SUPABASE_URL or "").rstrip("/")
        input_url = (base_url or env_supabase_url).rstrip("/")

        if not input_url:
            raise ValueError("SUPABASE_URL must be provided for Supabase AsyncGameClient")

        supabase_url = input_url.rstrip("/")

        super().__init__(
            base_url=supabase_url,
            character_id=character_id,
            actor_character_id=actor_character_id,
            entity_type=entity_type,
            allow_corp_actorless_control=allow_corp_actorless_control,
        )

        self._supabase_url = supabase_url
        self._functions_url = (
            functions_url.rstrip("/") if functions_url else f"{self._supabase_url}/functions/v1"
        )
        """
        self._service_role_key = settings.SUPABASE_SERVICE_ROLE_KEY
        if not self._service_role_key:
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")
        """
        self._anon_key = settings.SUPABASE_ANON_KEY or "anon-key"
        # EDGE_API_TOKEN goes in X-Edge-Auth and proves the request came
        # through a trusted backend. Production always sets it; tests and
        # local-dev rely on the server-side bypass (ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1)
        # where it's intentionally unset. We do NOT fall back to
        # SUPABASE_SERVICE_ROLE_KEY — that key is for direct DB access and
        # has different semantics from the edge-auth gate.
        self._edge_api_token = settings.EDGE_API_TOKEN or settings.SUPABASE_API_TOKEN

        self._http = httpx.AsyncClient(timeout=10.0)

        self._canonical_character_id = canonicalize_character_id(character_id)
        self._canonical_actor_character_id = (
            canonicalize_character_id(actor_character_id)
            if actor_character_id is not None
            else None
        )
        self._event_log_path = settings.SUPABASE_EVENT_LOG_PATH
        self._enable_event_polling = enable_event_polling

        # User's Supabase Auth access_token, forwarded to auth-gated edge
        # functions. Pubsub event delivery uses EDGE_API_TOKEN plus SQL scope
        # checks instead of this per-character JWT.
        self._access_token = access_token

        # Event-delivery adapter. Constructed and started only by an
        # explicit ``start_event_delivery()`` call once the caller is
        # ready to consume events. Pubsub callers register their session queue
        # before bootstrap RPCs, capture bootstrap request ids, and replay any
        # unrelated startup-window events after agent activation.
        self._event_adapter: Optional[EventAdapter] = None
        self._captured_bootstrap_request_ids: Optional[set[str]] = None

    def set_event_polling_scope(
        self,
        *,
        character_ids: Optional[list[str]] = None,
        corp_id: Optional[str] = None,
        ship_ids: Optional[list[str]] = None,
    ) -> None:
        """Update the event subscription scope (delegates to the adapter).

        No-op until the adapter is prepared or started.
        """
        if self._event_adapter is None:
            logger.debug("set_event_polling_scope: adapter not started; ignoring")
            return
        self._event_adapter.set_scope(
            character_ids=character_ids,
            corp_id=corp_id,
            ship_ids=ship_ids,
        )

    async def sync_event_polling_scope(self) -> None:
        if self._event_adapter is not None:
            await self._event_adapter.sync_scope()

    async def close(self):
        await super().close()
        if self._event_adapter is not None:
            await self._event_adapter.stop()
        if self._http:
            await self._http.aclose()
            self._http = None

    async def _request(
        self,
        endpoint: str,
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:  # type: ignore[override]
        http_client = self._ensure_http_client()

        req_id = str(uuid.uuid4())
        self.last_request_id = req_id  # Track for voice agent request correlation
        enriched = self._inject_character_ids(payload)
        if "request_id" not in enriched:
            enriched["request_id"] = req_id
        if self._captured_bootstrap_request_ids is not None:
            outbound_req_id = enriched.get("request_id")
            if isinstance(outbound_req_id, str) and outbound_req_id:
                self._captured_bootstrap_request_ids.add(outbound_req_id)

        edge_endpoint = endpoint.replace('.', '_')

        url = f"{self._functions_url}/{edge_endpoint}"
        from loguru import logger as _loguru
        t0 = time.monotonic()
        if edge_endpoint != "events_since":
            _loguru.info(f"API.send {url} req_id={req_id}")
        # wake_agent dispatches a remote BYOA spawn (Vercel sandbox cold
        # start is 30-90s; warm resume 2-10s). Its own outbound HTTP timeout
        # is `BYOA_WAKE_TIMEOUT_MS` (default 60s) — wait slightly longer
        # here so wake_agent's own timeout fires first and we get a real
        # 504 instead of a httpx ReadTimeout. Every other edge function
        # call stays on the tight 10s client default.
        post_kwargs: Dict[str, Any] = {
            "headers": self._edge_headers(),
            "json": enriched,
        }
        if edge_endpoint == "wake_agent":
            post_kwargs["timeout"] = 70.0
        try:
            response = await http_client.post(url, **post_kwargs)
        except Exception as exc:
            elapsed_ms = (time.monotonic() - t0) * 1000
            _loguru.error(
                f"API.fail {url} req_id={req_id} {elapsed_ms:.0f}ms "
                f"{type(exc).__name__}: {exc}"
            )
            raise
        elapsed_ms = (time.monotonic() - t0) * 1000
        if edge_endpoint != "events_since":
            _loguru.info(f"API.recv {url} {response.status_code} {elapsed_ms:.0f}ms")

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
            # Pass the full body so callers can read structured 409/403 fields
            # (e.g. ship_busy holder info) without needing to bypass _request.
            raise RPCError(
                endpoint,
                status,
                detail,
                code,
                body=data if isinstance(data, dict) else None,
            )

        result = {k: v for k, v in data.items() if k != "success"}
        result.setdefault("success", True)
        await self._maybe_synthesize_error_from_result(
            endpoint=endpoint,
            request_id=req_id,
            result=result,
        )
        await self._maybe_update_sector_from_response(endpoint, result)
        return result

    def _edge_headers(self) -> Dict[str, str]:
        # X-Edge-Auth carries EDGE_API_TOKEN — the trusted-backend gate the
        # server requires on every gameplay edge function call in production.
        # When the env var isn't set (test/local-dev), we omit the header
        # and rely on the server-side bypass (ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1).
        # X-API-Token carries the user's Supabase Auth JWT when the bot is
        # acting on behalf of a user — server returns ``bot`` context.
        headers = {
            "Content-Type": "application/json",
            "apikey": self._anon_key,
            "Authorization": f"Bearer {self._anon_key}",
        }
        if self._edge_api_token:
            headers["X-Edge-Auth"] = self._edge_api_token
        if self._access_token:
            headers["X-API-Token"] = self._access_token
        return headers

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
        override_character_id = _per_call_character_id.get()
        requested_character_id = override_character_id or enriched.get("character_id")
        if requested_character_id:
            enriched["character_id"] = canonicalize_character_id(str(requested_character_id))
        else:
            enriched["character_id"] = self._canonical_character_id
        if override_character_id and "from_character_id" in enriched:
            enriched["from_character_id"] = canonicalize_character_id(
                str(override_character_id)
            )

        override_actor = _per_call_actor_character_id.get()
        requested_actor = override_actor or enriched.get("actor_character_id")
        canonical_actor: Optional[str]
        if requested_actor:
            canonical_actor = canonicalize_character_id(str(requested_actor))
        else:
            canonical_actor = self._canonical_actor_character_id

        if canonical_actor is not None:
            enriched["actor_character_id"] = canonical_actor

        # Auto-inject task_id if set (for TaskAgent task correlation).
        # The Phase 1 broker prefers the ContextVar override so that
        # concurrent brokered RPCs can't cross-tag each other's events
        # by racing on the shared client field. Outside a broker
        # context the ContextVar is unset and the bound field wins.
        override_task_id = _per_call_task_id.get()
        effective_task_id = (
            override_task_id if override_task_id is not None else self._current_task_id
        )
        if effective_task_id and "task_id" not in enriched:
            enriched["task_id"] = effective_task_id

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

    async def purge_event_backlog(self) -> None:
        """Reset pending event delivery for non-bootstrap callers."""
        if not self._enable_event_polling:
            return
        if self._event_adapter is None:
            self._event_adapter = make_event_adapter(self)
        await self._event_adapter.purge_backlog()

    async def prepare_event_delivery_for_bootstrap(self) -> None:
        """Prepare the adapter before event-emitting bootstrap RPCs run."""
        if not self._enable_event_polling:
            return
        if self._event_adapter is None:
            self._event_adapter = make_event_adapter(self)
        self._captured_bootstrap_request_ids = set()
        await self._event_adapter.prepare_bootstrap()

    async def complete_event_delivery_bootstrap(self) -> None:
        """Discard bootstrap echoes and hold unrelated startup events."""
        if not self._enable_event_polling or self._event_adapter is None:
            return
        request_ids = self._captured_bootstrap_request_ids or set()
        self._captured_bootstrap_request_ids = None
        await self._event_adapter.complete_bootstrap(request_ids)

    async def replay_event_delivery_catchup(self) -> None:
        """Replay queued non-bootstrap events after the agent is active."""
        if not self._enable_event_polling or self._event_adapter is None:
            return
        await self._event_adapter.replay_catchup()

    async def start_event_delivery(self) -> None:
        """Construct the event adapter and start consuming events.

        Call this once the caller is ready for events to flow. Idempotent.
        """
        if not self._enable_event_polling:
            return
        if self._event_adapter is None:
            self._event_adapter = make_event_adapter(self)
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
