"""Chat agent aligned with TaskAgent + tools_schema.

Provides quick conversational responses and single-step tool calls.
Defers multi-step tasks to TaskAgent via a start_task tool.
"""

import json
import time
from typing import Dict, Any, Optional, Callable, List

from gradientbang.utils.base_llm_agent import BaseLLMAgent, LLMConfig
from gradientbang.utils.api_client import AsyncGameClient
from gradientbang.utils.prompts import GAME_DESCRIPTION, CHAT_INSTRUCTIONS
from gradientbang.utils.tools_schema import (
    MyStatus,
    PlotCourse,
    Move,
    StartTask,
    StopTask,
    Trade,
    RechargeWarpPower,
    TransferWarpPower,
    TransferCredits,
    BankDeposit,
    BankWithdraw,
    DumpCargo,
)


def create_chat_system_prompt() -> str:
    return f"""{GAME_DESCRIPTION}

{CHAT_INSTRUCTIONS}"""


class ChatAgent(BaseLLMAgent):
    def __init__(
        self,
        config: LLMConfig,
        game_client: AsyncGameClient,
        character_id: str,
        task_callback: Optional[Callable[[str, Dict[str, Any]], Any]] = None,
        cancel_task_callback: Optional[Callable[[bool], None]] = None,
        get_task_progress_callback: Optional[Callable[[], str]] = None,
        verbose_prompts: bool = False,
        output_callback: Optional[Callable[[str], None]] = None,
        debug_callback: Optional[Callable[[List[Dict[str, Any]], Optional[str]], None]] = None,
        status_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        super().__init__(
            config=config,
            game_client=game_client,
            character_id=character_id,
            verbose_prompts=verbose_prompts,
            output_callback=output_callback,
        )
        self.game_client = game_client
        self.task_callback = task_callback
        self.cancel_task_callback = cancel_task_callback
        self.get_task_progress_callback = get_task_progress_callback
        self.debug_callback = debug_callback
        self.status_callback = status_callback
        self.system_prompt = create_chat_system_prompt()

        # Register tools for quick actions + task control
        self.set_tools(
            [
                MyStatus,
                PlotCourse,
                Move,
                Trade,
                DumpCargo,
                RechargeWarpPower,
                TransferWarpPower,
                TransferCredits,
                BankDeposit,
                BankWithdraw,
                StartTask,
                StopTask,
            ]
        )

    def initialize_conversation(self):
        self.clear_messages()
        self.add_message({"role": "system", "content": self.system_prompt})

    async def process_message(self, user_input: str, task_progress: Optional[str] = None) -> str:
        # Include recent task progress for context
        if task_progress:
            content = [
                {"type": "text", "text": f"<task_progress>\n{task_progress}\n</task_progress>"},
                {"type": "text", "text": user_input},
            ]
            self.add_message({"role": "user", "content": content})
        else:
            self.add_message({"role": "user", "content": user_input})

        # Let BaseLLMAgent handle response + tool execution
        start = time.time()
        if self.debug_callback:
            self.debug_callback(self.messages.copy(), "Request in progress...")

        assistant_message = await self.get_assistant_response(reasoning_effort=None)

        if self.debug_callback:
            elapsed = time.time() - start
            self.debug_callback(self.messages.copy(), f"Complete ({elapsed:.2f}s)")

        return assistant_message.get("content", "")

    async def process_tool_call(self, tool_call: Dict[str, Any]):
        # Intercept start/stop task to integrate with TaskManager
        tool_name = tool_call["function"]["name"]
        tool_args = json.loads(tool_call["function"]["arguments"])

        if tool_name == "start_task":
            if not self.task_callback:
                result = {"success": False, "error": "No task callback configured"}
            else:
                # Build initial state (status only for now)
                try:
                    status = await self.game_client.my_status()
                except Exception as e:
                    status = {"error": str(e)}
                initial_state = {"status": status}
                desc = tool_args.get("task_description") or tool_args.get("description") or ""
                self.task_callback(desc, initial_state)
                result = {"success": True, "message": f"Task started: {desc}"}

            return (self.format_tool_message(tool_call["id"], result), False)

        if tool_name == "stop_task":
            if self.cancel_task_callback:
                self.cancel_task_callback(True)
            result = {"success": True, "message": "Cancellation requested"}
            return (self.format_tool_message(tool_call["id"], result), False)

        # For other tools, delegate to BaseLLMAgent and surface status updates when useful
        tool_message, should_continue, raw_result = await super().process_tool_call(
            tool_call
        )

        # Attempt to notify UI of status-impacting results
        try:
            if (
                tool_name
                in {
                    "move",
                    "trade",
                    "dump_cargo",
                    "recharge_warp_power",
                    "transfer_warp_power",
                    "transfer_credits",
                    "bank_deposit",
                    "bank_withdraw",
                    "my_status",
                }
                and self.status_callback
            ):
                payload = None
                if isinstance(raw_result, dict):
                    payload = raw_result
                elif hasattr(raw_result, "llm_summary"):
                    payload = dict(raw_result)
                elif tool_message and tool_message.get("content"):
                    try:
                        payload = json.loads(tool_message["content"])
                    except Exception:
                        payload = None
                if isinstance(payload, dict):
                    self.status_callback(payload)
        except Exception as e:
            if self.debug_callback:
                self.debug_callback(self.messages.copy(), f"Error processing tool call: {str(e)}")
            pass

        return (tool_message, should_continue, raw_result)

    def is_task_running(self) -> bool:
        # The ChatAgent does not own the task; TaskManager tracks it.
        return False
