# Terminal interface for player

Let's build a terminal interface for the player to interact with the game.

We can use the same architecture as the NPC interface.

## User interface

- Chat window. This replaces the character chooser element in the NPC interface.
- Task output. A scrolling, read-only text area that shows the log lines from task execution
- Local map.
- Movement history
- Port history

## Features

The player is interacting with the game through a "ship intelligence". The ship intelligence is a conversational AI with two modes:
  - Chat
  - Task execution

We will need to refactor llm_interface.py to support these two modes.

### Chat

This is a standard chat interface. The player types a message. The message is passed to the LLM for inference. The LLM returns a response, which is displayed in the chat window.

We will need to create a system prompt for the chat mode.

Each new player message is added to a messages array. Each response from the LLM is added to the messages array.

### Task execution

This is the same functionality that the current AsyncLLMAgent provides for our run_npc.py app.

For this new player app, the task execution can be started and stopped by the Chat LLM.

If the player asks the ship intelligence will start a task.
  - The task should execute asynchronously.
  - The player can continue to chat with the ship intelligence while the task is executing.
  - The chat log lines should be cached in a buffer. The log lines should be displayed immediately, as they are created, in the UI.
  - Any time a chat message is created by the player, if a task is executing, log lines from the task should be appended to the chat messages array along with the player input. Format the user message as two "text" content elements. The first element should be the task progress. <task_progress>log lines</task_progress>. The second element should be the player input. 
  - When log lines are used in the chat context, remove them from the buffer. Each log line should be passed to the chat LLM only one time.
  - When the task finishes, create a chat message with all log lines not yet seen by the chat LLM and trigger chat inference.
  - The player can tell the ship intelligence to stop an ongoing task.

### System prompt for chat

Create a system prompt for the ship intelligence. This should be as simple as creating a new CHAT_INSTRUCTIONS and appending that to the GAME_DESCRIPTION. But check this assumption.

## Architecture Decisions

Based on the questions and answers above, here are the key architectural decisions:

### 1. UI Framework: Textual
We'll use Textual as it's already in use by other tools in the codebase (character_viewer.py). This provides consistency and allows us to leverage existing patterns for TUI development.

### 2. Task Initiation: Natural Language with Tool Calling
The chat LLM will analyze user intent and decide whether to start a task. This will be accomplished through:
- A tool definition for `start_task` that the chat LLM can call
- ChatAgent asks clarifying questions if needed, then passes raw user request plus Q&A to TaskAgent
- TaskAgent is the better agentic planner and handles complex task decomposition
- System prompt guidance explaining when tasks are appropriate (navigation, trading, exploration)
- Natural conversation flow where the ship intelligence explains what it's doing

### 3. Log Management: Simple Buffer with Large Context
- "Log lines" refers to terminal output (like run_npc.py prints), not Python logging
- No complex buffering logic needed - use a simple deque with 1,000 line capacity
- Output lines flow from TaskAgent → buffer → both Task Output panel AND ChatAgent context
- Each output line appears in chat context exactly once (formatted within a single message with multiple content entries per OpenAI's format)
- When buffer fills, oldest lines are dropped (though 1,000 lines should be sufficient for most tasks)

### 4. LLM Refactoring: Base Class with Specialized Agents
- Extract `BaseLLMAgent` with shared OpenAI client, message formatting, and error handling
- `ChatAgent`: Handles conversational AI with tool calling for task management
- `TaskAgent`: Refactored `AsyncLLMAgent` for OODA loop task execution
- Both agents share a single `AsyncGameClient` instance with truly shared state
- Add asyncio locks to AsyncGameClient as needed after code review for thread-safe cache operations

### 5. State Updates: Polling Without Firehose
- No WebSocket subscription (respecting game architecture boundaries)
- 2-second idle polling using asyncio timer
- Immediate updates after any game action (move, status, etc.)
- All updates go through shared `AsyncGameClient` cache

### 6. Task Cancellation: Immediate with State Recovery
- Cancellation sets a flag that TaskAgent checks between actions
- No graceful shutdown - task stops immediately
- After cancellation, force refresh game state from server
- ChatAgent acknowledges cancellation and reports current state

## Key Technical Details

### OpenAI Message Format for Task Progress
When injecting task progress into chat context, use OpenAI's multi-content message format:
```python
{
    "role": "user",
    "content": [
        {"type": "text", "text": "<task_progress>\n[task output lines]\n</task_progress>"},
        {"type": "text", "text": "[user's actual message]"}
    ]
}
```
This allows the chat LLM to see both the task progress and user input in proper context.

### Session Management
- Chat history starts fresh each session (no persistence)
- Full context maintained for long sessions (using long-context LLMs)
- One task allowed at a time (enforced by ChatAgent)
- Fixed 2-second polling for multiplayer awareness
- On startup: fetch status → send as user message → ChatAgent generates welcome
- Task output is plain text (no ANSI colors, no emojis)

### Task Flow Architecture
1. User requests a complex action in chat
2. ChatAgent recognizes need for task execution
3. ChatAgent may ask clarifying questions
4. ChatAgent calls `start_task` tool with:
   - String containing relevant chat history (user message or full dialog if clarified)
   - Current game state snapshot (sector, cargo, credits, etc.)
5. TaskAgent (superior planner) receives context and state, decomposes and executes the task
6. Output lines (plain text, no colors/emojis) flow to both Task Output panel and buffer
7. On next user message or task completion, buffered lines inject into chat
8. ChatAgent acknowledges progress/completion
9. If error occurs, TaskAgent treats task as finished and error appears in output lines

### ChatAgent vs TaskAgent Responsibilities
- **ChatAgent handles simple operations directly:**
  - Local state queries (current sector, cargo, credits)
  - Single API calls (scan one port, check one sector)
  - Quick lookups from cached map knowledge
  - Starting/stopping tasks (passes game state snapshot when starting)
  - Enforcing one-task-at-a-time rule (refuse new task if one is running)
  - Error recovery tools: `reset_client` and `force_refresh` for edge cases
  
- **TaskAgent handles complex operations:**
  - Multi-step navigation (plotting courses, moving through sectors)
  - Trading sequences (find ports, compare prices, execute trades)
  - Exploration (systematic sector scanning)
  - Any operation requiring planning and multiple coordinated actions
  - On error: treat task as complete, error appears in output for ChatAgent to handle

## Implementation Plan

### Phase 1: LLM Refactoring
1. **Create `utils/base_llm_agent.py`**
   - Extract common functionality from current `AsyncLLMAgent`
   - OpenAI client initialization
   - Message formatting utilities
   - Error handling and retry logic
   - Shared logging configuration

2. **Create `utils/chat_agent.py`**
   - Inherit from `BaseLLMAgent`
   - Implement chat conversation management
   - Define simplified tools for quick queries:
     - `start_task`: Pass chat history + game state snapshot to TaskAgent
     - `stop_task`: Cancel running task immediately
     - `get_status`: Simple local state lookup from AsyncGameClient cache
     - `view_map`: Display cached map knowledge
     - `scan_port`: Single API call to check a port
     - `check_cargo`: Local cache lookup
     - `reset_client`: Reinitialize AsyncGameClient for error recovery
     - `force_refresh`: Bypass cache and get fresh state from server
   - System prompt with ship intelligence personality and task decision logic
   - Method to inject task progress into conversation context using multi-content messages

3. **Create `utils/task_agent.py`**
   - Refactor existing `AsyncLLMAgent` to inherit from `BaseLLMAgent`
   - Keep OODA loop implementation as the superior task planner
   - Add cancellation checking between tool calls
   - Replace terminal printing with callback for output lines (plain text, no colors/emojis)
   - Callback receives formatted strings that would normally go to terminal
   - On error: complete task and include error in output lines
   - Clean separation from chat functionality

### Phase 2: AsyncGameClient Concurrency
1. **Review `utils/api_client.py`**
   - Examine existing code for thread-safety issues
   - Add asyncio locks around all cache mutations for truly shared state
   - Both ChatAgent and TaskAgent will use the same instance concurrently
   - Test concurrent access patterns

2. **Add connection pooling if needed**
   - Check if httpx client supports concurrent requests
   - Add semaphores for rate limiting if necessary

### Phase 3: TUI Components
1. **Create `tui/widgets/chat_widget.py`**
   - Textual widget for chat display and input
   - Message formatting with timestamps
   - Scroll to bottom on new messages
   - Handle multi-line input for complex commands

2. **Create `tui/widgets/task_output_widget.py`**
   - Read-only scrolling text area
   - Color coding for different log types (info, error, success)
   - Auto-scroll with pause option
   - Clear button for log history (Ctrl+L shortcut)

3. **Create `tui/widgets/map_widget.py`**
   - ASCII representation of local sectors
   - Current position highlight
   - Known connections and ports
   - Refresh from AsyncGameClient cache

4. **Create `tui/widgets/history_widgets.py`**
   - Movement history: recent sector visits with timestamps
   - Port history: discovered ports with commodities
   - Both update from AsyncGameClient state

5. **Create `tui/widgets/progress_widget.py`**
   - Shows current task description
   - Elapsed time counter
   - Last significant action (e.g., "Moving to sector 45...")
   - Visible indicator when task is running vs idle

### Phase 4: Task Management
1. **Create `tui/task_manager.py`**
   - Coordinate between ChatAgent and TaskAgent
   - Manage task lifecycle (start, monitor, cancel)
   - Buffer for log lines (deque with 1,000 capacity)
   - Async task execution with cancellation support
   - Callback registration for UI updates

2. **Implement log line flow**
   - TaskAgent → callback → buffer
   - Buffer → ChatAgent context on new user message
   - Buffer → ChatAgent on task completion
   - Clear buffer after injection into chat

### Phase 5: Main Application
1. **Create `tui/player_app.py`**
   - Textual App subclass
   - Layout management (CSS Grid or Dock)
   - Initialize shared AsyncGameClient
   - Create ChatAgent and TaskManager
   - Wire up all widgets with data sources
   - Implement 2-second fixed polling timer (multiplayer needs immediate updates)
   - Keyboard shortcuts:
     - `Ctrl+C`: Cancel current task
     - `Tab`: Cycle focus between widgets
     - `Ctrl+L`: Clear task output
     - `Ctrl+R`: Force refresh from server
     - `F1`: Show help/commands
   - Startup sequence:
     - Fetch character's current status
     - Pass status as user message to trigger welcome greeting
     - Display welcome message in chat
   - Fresh chat history each session (no persistence)

2. **Create `player_tui.py`** (entry point)
   - Argument parsing:
     - Required: character ID (positional argument)
     - Optional: --server URL (default: http://localhost:8000)
   - Environment setup (API keys)
   - Launch Textual app with specified character
   - Graceful shutdown handling

### Phase 6: System Prompts
1. **Chat system prompt**
   - Ship intelligence personality (helpful, knowledgeable, slightly quirky)
   - Game world knowledge (sectors, ports, commodities)
   - Task initiation guidelines (when to start vs. just advise)
   - Safety boundaries (no self-destruct, respect game rules)

2. **Tool descriptions**
   - Clear, concise descriptions for each chat tool
   - Examples of when to use each tool
   - Parameter validation rules

### Phase 7: Testing & Polish
1. **Integration tests**
   - Chat → Task flow
   - Task cancellation mid-execution
   - Concurrent state updates
   - Buffer overflow handling

2. **UI Polish**
   - Keyboard shortcuts fully implemented:
     - `Ctrl+C`: Cancel current task
     - `Tab`: Cycle focus between widgets
     - `Ctrl+L`: Clear task output
     - `Ctrl+R`: Force refresh from server
     - `F1`: Show help/commands
   - Color themes
   - Responsive layout for different terminal sizes
   - Help dialog with full command list

3. **Error handling**
   - Network disconnection recovery
   - Invalid game states
   - LLM API failures with graceful degradation
   - Clear error messages in UI



