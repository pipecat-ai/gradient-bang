import json
import sys
import types

import pytest

if "openai" not in sys.modules:
    class _AsyncOpenAIStub:  # pragma: no cover - stub for tests
        def __init__(self, *args, **kwargs):
            pass

    openai_module = types.ModuleType("openai")
    openai_module.AsyncOpenAI = _AsyncOpenAIStub

    openai_types_module = types.ModuleType("openai.types")
    openai_chat_module = types.ModuleType("openai.types.chat")

    class ChatCompletionToolParam(dict):  # pragma: no cover - stub
        pass

    openai_chat_module.ChatCompletionToolParam = ChatCompletionToolParam
    openai_types_module.chat = openai_chat_module
    openai_module.types = openai_types_module

    sys.modules["openai"] = openai_module
    sys.modules["openai.types"] = openai_types_module
    sys.modules["openai.types.chat"] = openai_chat_module

if "loguru" not in sys.modules:
    class _LoggerStub:  # pragma: no cover - stub for tests
        def __getattr__(self, _name):
            return lambda *args, **kwargs: None

    sys.modules["loguru"] = types.SimpleNamespace(logger=_LoggerStub())

if "pipecat" not in sys.modules:
    pipecat_module = types.ModuleType("pipecat")
    adapters_module = types.ModuleType("pipecat.adapters")
    schemas_package = types.ModuleType("pipecat.adapters.schemas")
    services_package = types.ModuleType("pipecat.adapters.services")

    class ToolsSchema:  # pragma: no cover - stub
        def __init__(self, entries):
            self.entries = entries

    class FunctionSchema:  # pragma: no cover - stub
        def __init__(self, name, description, properties=None, required=None):
            self.name = name
            self.description = description
            self.properties = properties or {}
            self.required = required or []

    class OpenAILLMAdapter:  # pragma: no cover - stub
        def to_provider_tools_format(self, _tools_schema):
            return []

    tools_schema_module = types.ModuleType("pipecat.adapters.schemas.tools_schema")
    tools_schema_module.ToolsSchema = ToolsSchema
    function_schema_module = types.ModuleType("pipecat.adapters.schemas.function_schema")
    function_schema_module.FunctionSchema = FunctionSchema
    openai_adapter_module = types.ModuleType("pipecat.adapters.services.open_ai_adapter")
    openai_adapter_module.OpenAILLMAdapter = OpenAILLMAdapter

    sys.modules["pipecat"] = pipecat_module
    sys.modules["pipecat.adapters"] = adapters_module
    sys.modules["pipecat.adapters.schemas"] = schemas_package
    sys.modules["pipecat.adapters.schemas.tools_schema"] = tools_schema_module
    sys.modules["pipecat.adapters.schemas.function_schema"] = function_schema_module
    sys.modules["pipecat.adapters.services"] = services_package
    sys.modules["pipecat.adapters.services.open_ai_adapter"] = openai_adapter_module

from npc.combat_strategy import CombatStrategyRuntime, request_agent_action


class DummyAgent:
    def __init__(self, runtime, responses):
        self.runtime = runtime
        self.responses = responses
        self.messages = []
        self._response_index = 0

    def add_message(self, message):
        self.messages.append(message)

    async def get_assistant_response(self):
        response = self.responses[self._response_index]
        self._response_index = min(self._response_index + 1, len(self.responses) - 1)
        return response

    async def process_tool_call(self, tool_call):
        fn = tool_call["function"]["name"]
        args = json.loads(tool_call["function"]["arguments"] or "{}")
        if fn == "choose_combat_action":
            result = self.runtime.choose_action(
                args.get("action"),
                args.get("commit"),
                args.get("target"),
                args.get("to_sector"),
            )
        elif fn == "set_commit":
            result = self.runtime.set_commit(args.get("commit", 0))
        elif fn == "review_round_log":
            result = self.runtime.review_last_round()
        else:
            result = {}
        tool_message = {
            "role": "tool",
            "content": json.dumps(result),
            "tool_call_id": tool_call.get("id", "tool-call"),
        }
        return tool_message, True, result


@pytest.mark.asyncio
async def test_request_agent_action_reads_tool_choice():
    runtime = CombatStrategyRuntime()
    responses = [
        {
            "tool_calls": [
                {
                    "function": {
                        "name": "choose_combat_action",
                        "arguments": json.dumps(
                            {"action": "attack", "commit": 5, "target": "enemy"}
                        ),
                    }
                }
            ]
        }
    ]
    agent = DummyAgent(runtime, responses)
    observation = json.dumps({"round_state": {"round": 1}})
    action, commit, target, to_sector = await request_agent_action(
        agent,
        runtime,
        observation,
        logger=type("L", (), {"warning": print, "error": print})(),
        deadline_seconds=10.0,
    )
    assert action == "attack"
    assert commit == 5
    assert target == "enemy"
    assert to_sector is None


@pytest.mark.asyncio
async def test_request_agent_action_defaults_when_no_time():
    runtime = CombatStrategyRuntime()
    agent = DummyAgent(runtime, responses=[{"tool_calls": []}])
    observation = json.dumps({"round_state": {"round": 1}})
    action, commit, target, to_sector = await request_agent_action(
        agent,
        runtime,
        observation,
        logger=type("L", (), {"warning": lambda *args, **kwargs: None, "error": print})(),
        deadline_seconds=0.25,
    )
    assert action == "brace"
    assert commit == 0
    assert target is None
    assert to_sector is None


def test_choose_action_requires_destination_for_flee():
    runtime = CombatStrategyRuntime()
    with pytest.raises(ValueError):
        runtime.choose_action("flee", None, None, None)
