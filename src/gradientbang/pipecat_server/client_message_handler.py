"""Client message handler — routes RTVI client messages to game actions."""

import asyncio
from datetime import datetime, timedelta, timezone

from loguru import logger
from pipecat.frames.frames import (
    InterruptionFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    TTSUpdateSettingsFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
from pipecat.utils.time import time_now_iso8601

from gradientbang.pipecat_server.frames import UserTextInputFrame


class ClientMessageHandler:
    """Routes incoming RTVI client messages to the appropriate game/pipeline action."""

    def __init__(
        self,
        *,
        game_client,
        character_id: str,
        rtvi,
        transport,
        main_agent,
        tts,
        say_text_restore_voice: dict,
        user_mute_state: dict,
        user_unmuted_event: asyncio.Event,
        llm_context=None,
        voice_agent=None,
    ):
        self._game_client = game_client
        self._character_id = character_id
        self._rtvi = rtvi
        self._transport = transport
        self._main_agent = main_agent
        self._tts = tts
        self._say_text_restore_voice = say_text_restore_voice
        self._user_mute_state = user_mute_state
        self._user_unmuted_event = user_unmuted_event
        self._llm_context = llm_context
        self._voice_agent = voice_agent

    @property
    def _pipeline_task(self):
        return getattr(self._main_agent, "_pipeline_task", None)

    async def handle(self, message):
        """Dispatch a client message to the appropriate handler."""
        logger.info(f"Received client message: {message}")

        msg_type = message.type
        msg_data = message.data if hasattr(message, "data") else {}

        handler = self._HANDLERS.get(msg_type)
        if handler:
            await handler(self, msg_type, msg_data)

    # ── Individual handlers ───────────────────────────────────────────

    async def _handle_start(self, msg_type, msg_data):
        if self._pipeline_task:
            await self._pipeline_task.queue_frames([LLMRunFrame()])

    async def _handle_mute_unmute(self, msg_type, msg_data):
        try:
            mute = bool((msg_data or {}).get("mute"))
        except Exception:
            mute = False
        try:
            self._transport.set_input_muted(mute)
            logger.info(f"Microphone {'muted' if mute else 'unmuted'} (transport flag)")
        except Exception:
            from pipecat.frames.frames import StartFrame, StopFrame

            if mute:
                await self._transport.input().push_frame(StopFrame())
                logger.info("Microphone muted (StopFrame fallback)")
            else:
                await self._transport.input().push_frame(StartFrame())
                logger.info("Microphone unmuted (StartFrame fallback)")

    async def _handle_get_my_status(self, msg_type, msg_data):
        await self._game_client.my_status(self._character_id)

    async def _handle_get_known_ports(self, msg_type, msg_data):
        await self._game_client.list_known_ports(self._character_id)

    async def _handle_get_task_history(self, msg_type, msg_data):
        try:
            ship_id = msg_data.get("ship_id") if isinstance(msg_data, dict) else None
            max_rows_raw = msg_data.get("max_rows") if isinstance(msg_data, dict) else None
            max_rows = int(max_rows_raw) if max_rows_raw is not None else 50

            end_time = datetime.now(timezone.utc)
            start_time = end_time - timedelta(days=30)
            target_character = ship_id or self._character_id

            start_query = self._game_client.event_query(
                start=start_time.isoformat(),
                end=end_time.isoformat(),
                character_id=target_character,
                filter_event_type="task.start",
                max_rows=max_rows + 10,
                sort_direction="reverse",
            )
            finish_query = self._game_client.event_query(
                start=start_time.isoformat(),
                end=end_time.isoformat(),
                character_id=target_character,
                filter_event_type="task.finish",
                max_rows=max_rows + 10,
                sort_direction="reverse",
            )
            start_result, finish_result = await asyncio.gather(start_query, finish_query)

            start_events = start_result.get("events", [])
            finish_events = finish_result.get("events", [])

            finish_by_task_id: dict = {}
            for event in finish_events:
                task_id = event.get("task_id")
                if task_id:
                    finish_by_task_id[task_id] = event

            tasks = []
            for start_event in start_events:
                task_id = start_event.get("task_id")
                if not task_id:
                    continue
                finish_event = finish_by_task_id.get(task_id)
                start_payload = start_event.get("payload", {})
                finish_payload = finish_event.get("payload", {}) if finish_event else {}
                end_summary = None
                end_status = None
                if finish_event:
                    end_summary = (
                        finish_payload.get("task_summary")
                        or finish_payload.get("summary")
                        or finish_payload.get("result")
                    )
                    end_status = finish_payload.get("task_status")
                tasks.append(
                    {
                        "task_id": task_id,
                        "started": start_event.get("timestamp"),
                        "ended": finish_event.get("timestamp") if finish_event else None,
                        "start_instructions": start_payload.get("task_description")
                        or start_payload.get("instructions")
                        or "",
                        "end_summary": end_summary,
                        "end_status": end_status,
                        "actor_character_id": start_payload.get("actor_character_id"),
                        "actor_character_name": start_payload.get("actor_character_name"),
                        "task_scope": start_payload.get("task_scope"),
                        "ship_id": start_payload.get("ship_id"),
                        "ship_name": start_payload.get("ship_name"),
                        "ship_type": start_payload.get("ship_type"),
                    }
                )

            tasks.sort(key=lambda t: t["started"] or "", reverse=True)
            tasks = tasks[:max_rows]

            await self._rtvi.push_frame(
                RTVIServerMessageFrame(
                    {
                        "frame_type": "event",
                        "event": "task.history",
                        "payload": {"tasks": tasks, "total_count": len(tasks)},
                    }
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to fetch task history")
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
            )

    async def _handle_get_task_events(self, msg_type, msg_data):
        try:
            if not isinstance(msg_data, dict) or not msg_data.get("task_id"):
                raise ValueError("get-task-events requires task_id in message data")
            task_id = msg_data.get("task_id")
            cursor_raw = msg_data.get("cursor")
            cursor = int(cursor_raw) if cursor_raw is not None else None
            max_rows_raw = msg_data.get("max_rows")
            max_rows = int(max_rows_raw) if max_rows_raw is not None else None

            end_time = datetime.now(timezone.utc)
            start_time = end_time - timedelta(hours=24)
            result = await self._game_client.event_query(
                start=start_time.isoformat(),
                end=end_time.isoformat(),
                filter_task_id=task_id,
                character_id=self._character_id,
                cursor=cursor,
                max_rows=max_rows,
            )
            await self._rtvi.push_frame(
                RTVIServerMessageFrame(
                    {"frame_type": "event", "event": "event.query", "payload": result}
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to fetch task events")
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
            )

    async def _handle_get_chat_history(self, msg_type, msg_data):
        from gradientbang.pipecat_server.chat_history import emit_chat_history, fetch_chat_history

        try:
            since_hours_raw = (
                msg_data.get("since_hours") if isinstance(msg_data, dict) else None
            )
            since_hours = int(since_hours_raw) if since_hours_raw is not None else 24
            max_rows_raw = msg_data.get("max_rows") if isinstance(msg_data, dict) else None
            max_rows = int(max_rows_raw) if max_rows_raw is not None else 50

            chat_messages = await fetch_chat_history(
                self._game_client,
                self._character_id,
                since_hours=since_hours,
                max_rows=max_rows,
            )
            await emit_chat_history(self._rtvi, chat_messages)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to fetch chat history")
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
            )

    async def _handle_cancel_task(self, msg_type, msg_data):
        try:
            if not isinstance(msg_data, dict) or not msg_data.get("task_id"):
                raise ValueError("cancel-task requires task_id in message data")
            await self._game_client.task_cancel(
                task_id=msg_data.get("task_id"),
                character_id=self._character_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to cancel task via client message")
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
            )

    async def _handle_get_my_ships(self, msg_type, msg_data):
        try:
            await self._game_client.list_user_ships(character_id=self._character_id)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to fetch user ships")
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
            )

    async def _handle_get_ship_definitions(self, msg_type, msg_data):
        try:
            await self._game_client.get_ship_definitions(include_description=True)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to fetch ship definitions")
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
            )

    async def _handle_get_my_corporation(self, msg_type, msg_data):
        try:
            await self._game_client._request(
                "my_corporation", {"character_id": self._character_id}
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to fetch corporation data")
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
            )

    async def _handle_get_my_map(self, msg_type, msg_data):
        try:
            if not isinstance(msg_data, dict):
                raise ValueError("Message data must be an object")

            fit_sectors = msg_data.get("fit_sectors")
            if fit_sectors is not None:
                if not isinstance(fit_sectors, list):
                    raise ValueError("fit_sectors must be a list of sector IDs")
                fit_sectors = [
                    int(sector)
                    for sector in fit_sectors
                    if isinstance(sector, (int, float, str)) and str(sector).strip() != ""
                ]
                if not fit_sectors:
                    raise ValueError("fit_sectors must include at least one sector")
            else:
                center_sector = msg_data.get("center_sector")
                if center_sector is None:
                    raise ValueError("Missing required field 'center_sector'")
                center_sector = int(center_sector)

            bounds_raw = msg_data.get("bounds")
            max_sectors_raw = msg_data.get("max_sectors")
            max_hops_raw = msg_data.get("max_hops")

            bounds = int(bounds_raw) if bounds_raw is not None else None
            if bounds is not None and (bounds < 0 or bounds > 100):
                raise ValueError("bounds must be between 0 and 100")

            max_hops = (
                int(max_hops_raw)
                if max_hops_raw is not None
                else None
                if bounds is not None
                else 3
            )
            if max_hops is not None and (max_hops < 0 or max_hops > 100):
                raise ValueError("max_hops must be between 0 and 100")

            max_sectors = (
                int(max_sectors_raw)
                if max_sectors_raw is not None
                else None
                if bounds is not None
                else 1000
            )
            if max_sectors is not None and max_sectors <= 0:
                raise ValueError("max_sectors must be positive")

            await self._game_client.local_map_region(
                character_id=self._character_id,
                center_sector=center_sector if fit_sectors is None else None,
                bounds=bounds,
                max_hops=max_hops,
                max_sectors=max_sectors,
                fit_sectors=fit_sectors,
                source="get-my-map",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to fetch local map region via client message")
            await self._rtvi.push_frame(
                RTVIServerMessageFrame({"frame_type": "error", "error": str(exc)})
            )

    async def _handle_salvage_collect(self, msg_type, msg_data):
        await self._game_client.salvage_collect(
            character_id=self._character_id,
            salvage_id=msg_data.get("salvage_id"),
        )

    async def _handle_combat_action(self, msg_type, msg_data):
        try:
            await self._game_client.combat_action(
                character_id=self._character_id,
                combat_id=msg_data.get("combat_id"),
                action=msg_data.get("action"),
                commit=msg_data.get("commit", 0) or 0,
                round_number=msg_data.get("round"),
                target_id=msg_data.get("target_id"),
                to_sector=msg_data.get("to_sector"),
            )
        except Exception as exc:
            logger.error(f"combat-action failed: {exc}")
            await self._rtvi.send_server_message({"frame_type": "error", "error": str(exc)})

    async def _handle_say_text(self, msg_type, msg_data):
        pipeline_task = self._pipeline_task
        if not pipeline_task:
            return
        # Ignore say-text while user input is muted (e.g. during the join intro).
        if self._user_mute_state.get("muted"):
            logger.info("say-text ignored: user input is muted (intro in progress)")
            return
        text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
        voice_id = msg_data.get("voice_id") if isinstance(msg_data, dict) else None
        if text:
            await pipeline_task.queue_frame(InterruptionFrame())
            frames = []
            if voice_id:
                if not self._say_text_restore_voice.get("voice_id"):
                    self._say_text_restore_voice["voice_id"] = self._tts._settings.voice
                frames.append(TTSUpdateSettingsFrame(settings={"voice_id": voice_id}))
            else:
                self._say_text_restore_voice["voice_id"] = None
            frames.append(TTSSpeakFrame(text=text, append_to_context=False))
            if voice_id:
                frames.append(
                    TTSUpdateSettingsFrame(
                        settings={"voice_id": self._say_text_restore_voice["voice_id"]}
                    )
                )
            await pipeline_task.queue_frames(frames)

    async def _handle_say_text_dismiss(self, msg_type, msg_data):
        pipeline_task = self._pipeline_task
        if not pipeline_task:
            return
        await pipeline_task.queue_frame(InterruptionFrame())
        restore_id = self._say_text_restore_voice.get("voice_id")
        frames = []
        if restore_id:
            frames.append(TTSUpdateSettingsFrame(settings={"voice_id": restore_id}))
            self._say_text_restore_voice["voice_id"] = None
        # Append context about the briefing and trigger inference so the bot
        # can address anything that happened during the dialog (e.g. task
        # completions). The inference gate handles cooldown/timing.
        frames.append(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "user",
                        "content": "<event>The player just finished reading a contract briefing dialog. Do not comment on this unless there are pending events to address.</event>",
                    }
                ],
                run_llm=True,
            )
        )
        await pipeline_task.queue_frames(frames)

    async def _handle_user_text_input(self, msg_type, msg_data):
        pipeline_task = self._pipeline_task
        if not pipeline_task:
            return
        text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
        await pipeline_task.queue_frame(UserTextInputFrame(text=text))
        if self._user_mute_state["muted"]:
            try:
                await asyncio.wait_for(self._user_unmuted_event.wait(), timeout=0.5)
            except asyncio.TimeoutError:
                logger.warning("Timed out waiting for user unmute after text input")
        frames = [InterruptionFrame()]
        if text.strip():
            logger.info(f"[USER-TEXT-INPUT] Received text: {text}")
            frames.extend(
                [
                    UserStartedSpeakingFrame(),
                    TranscriptionFrame(
                        text=text, user_id="player", timestamp=time_now_iso8601()
                    ),
                    UserStoppedSpeakingFrame(),
                ]
            )
        await pipeline_task.queue_frames(frames)

    async def _handle_assign_quest(self, msg_type, msg_data):
        quest_code = msg_data.get("quest_code", "") if isinstance(msg_data, dict) else ""
        if not quest_code:
            logger.warning("assign-quest: missing quest_code")
            return
        try:
            result = await self._game_client.assign_quest(
                quest_code=quest_code,
                character_id=self._character_id,
            )
            logger.info(f"assign-quest result: {result}")
        except Exception as e:
            logger.error(f"assign-quest failed: {e}")

    async def _handle_custom_message(self, msg_type, msg_data):
        text = msg_data.get("text", "") if isinstance(msg_data, dict) else ""
        if text:
            await self._rtvi.send_server_message(
                {"type": "message-received", "text": f"Received: {text}"}
            )

    async def _handle_dump_llm_context(self, msg_type, msg_data):
        """Debug: dump voice agent context + all task agent contexts."""
        import json

        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        def safe_serialize(msg):
            try:
                json.dumps(msg)
                return msg
            except (TypeError, ValueError):
                return {"role": msg.get("role", "unknown"), "content": str(msg.get("content", ""))}

        sections = []

        # Voice agent context
        if self._llm_context:
            voice_messages = [safe_serialize(m) for m in self._llm_context.get_messages()]
            voice_json = json.dumps(voice_messages, indent=2, ensure_ascii=False).replace("\\n", "\n")
            sections.append(
                f"{'=' * 60}\n"
                f"  VOICE AGENT CONTEXT ({len(voice_messages)} messages)\n"
                f"{'=' * 60}\n\n"
                f"{voice_json}"
            )

        # Task agent contexts
        if self._voice_agent:
            for child in self._voice_agent.children:
                if not isinstance(child, TaskAgent):
                    continue
                messages = child.get_context_dump()
                if not messages:
                    continue
                safe_messages = [safe_serialize(m) for m in messages]
                task_json = json.dumps(safe_messages, indent=2, ensure_ascii=False).replace("\\n", "\n")
                task_label = child._active_task_id or child.name
                task_type = "corp_ship" if child._is_corp_ship else "player_ship"
                sections.append(
                    f"{'=' * 60}\n"
                    f"  TASK AGENT: {child.name} ({task_type}) — {task_label}\n"
                    f"{'=' * 60}\n\n"
                    f"{task_json}"
                )

        if not sections:
            await self._rtvi.push_frame(
                RTVIServerMessageFrame(
                    {"frame_type": "error", "error": "No context available"}
                )
            )
            return

        formatted = "\n\n".join(sections)

        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "debug.llm-context",
                    "payload": {
                        "message_count": len(sections),
                        "formatted": formatted,
                    },
                }
            )
        )

    async def _handle_dump_task_context(self, msg_type, msg_data):
        """Debug: dump a task agent's LLM context back to the client.

        Tries in-memory context first (live/cached), then falls back to S3.
        """
        import json

        from gradientbang.pipecat_server.subagents.task_agent import TaskAgent

        task_id = msg_data.get("task_id") if isinstance(msg_data, dict) else None
        if not task_id:
            return

        # Try in-memory context first — only exact task_id matches.
        # The broad "any player task agent" fallback is intentionally removed
        # so that historical tasks correctly fall through to the S3 path.
        messages = None
        if self._voice_agent:
            child = next(
                (c for c in self._voice_agent.children
                 if isinstance(c, TaskAgent)
                 and (c.name == task_id or c._active_task_id == task_id)),
                None,
            )
            if child:
                messages = child.get_context_dump()

        # Fall back to S3 for historical tasks.
        if not messages:
            from gradientbang.pipecat_server.context_upload import (
                ContextNotFoundError,
                download_task_context,
            )

            try:
                messages = await download_task_context(task_id, self._character_id)
            except ContextNotFoundError as exc:
                logger.debug(f"dump-task-context: not found for {task_id}: {exc}")
                await self._rtvi.push_frame(
                    RTVIServerMessageFrame(
                        {
                            "frame_type": "event",
                            "event": "debug.task-context-error",
                            "payload": {
                                "task_id": task_id,
                                "error": "No saved context found for this task.",
                            },
                        }
                    )
                )
                return
            except Exception as exc:
                logger.error(f"dump-task-context: S3 download failed for {task_id}: {exc}")
                await self._rtvi.push_frame(
                    RTVIServerMessageFrame(
                        {
                            "frame_type": "event",
                            "event": "debug.task-context-error",
                            "payload": {
                                "task_id": task_id,
                                "error": "Failed to download context. Check server logs.",
                            },
                        }
                    )
                )
                return

        def safe_serialize(msg):
            try:
                json.dumps(msg)
                return msg
            except (TypeError, ValueError):
                return {"role": msg.get("role", "unknown"), "content": str(msg.get("content", ""))}

        safe_messages = [safe_serialize(m) for m in messages]
        formatted = json.dumps(safe_messages, indent=2, ensure_ascii=False)
        formatted = formatted.replace("\\n", "\n")

        await self._rtvi.push_frame(
            RTVIServerMessageFrame(
                {
                    "frame_type": "event",
                    "event": "debug.task-context",
                    "payload": {
                        "task_id": task_id,
                        "message_count": len(safe_messages),
                        "formatted": formatted,
                    },
                }
            )
        )

    # ── Dispatch table ────────────────────────────────────────────────

    _HANDLERS = {
        "start": _handle_start,
        "mute-unmute": _handle_mute_unmute,
        "get-my-status": _handle_get_my_status,
        "get-known-ports": _handle_get_known_ports,
        "get-task-history": _handle_get_task_history,
        "get-task-events": _handle_get_task_events,
        "get-chat-history": _handle_get_chat_history,
        "cancel-task": _handle_cancel_task,
        "get-my-ships": _handle_get_my_ships,
        "get-ship-definitions": _handle_get_ship_definitions,
        "get-my-corporation": _handle_get_my_corporation,
        "get-my-map": _handle_get_my_map,
        "salvage_collect": _handle_salvage_collect,
        "combat-action": _handle_combat_action,
        "say-text": _handle_say_text,
        "say-text-dismiss": _handle_say_text_dismiss,
        "user-text-input": _handle_user_text_input,
        "assign-quest": _handle_assign_quest,
        "custom-message": _handle_custom_message,
        "dump-llm-context": _handle_dump_llm_context,
        "dump-task-context": _handle_dump_task_context,
    }
