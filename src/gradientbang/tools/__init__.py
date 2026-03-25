"""Shared tool schemas for VoiceAgent and TaskAgent.

Exports curated ToolsSchema sets:
- VOICE_TOOLS: 16 tools for the conversational voice agent
- TASK_TOOLS: 31 tools for autonomous task execution
"""

from pipecat.adapters.schemas.tools_schema import ToolsSchema

from gradientbang.tools.schemas import (
    # Method aliases
    GAME_METHOD_ALIASES,
    # Navigation
    MOVE,
    PLOT_COURSE,
    MY_MAP,
    LOCAL_MAP_REGION,
    PATH_WITH_REGION,
    # Trading
    TRADE,
    LIST_KNOWN_PORTS,
    SALVAGE_COLLECT,
    DUMP_CARGO,
    # Resources
    RECHARGE_WARP_POWER,
    PURCHASE_FIGHTERS,
    TRANSFER_WARP_POWER,
    TRANSFER_CREDITS,
    BANK_DEPOSIT,
    BANK_WITHDRAW,
    PLACE_FIGHTERS,
    COLLECT_FIGHTERS,
    # Corporation
    CREATE_CORPORATION,
    JOIN_CORPORATION,
    LEAVE_CORPORATION,
    KICK_CORPORATION_MEMBER,
    CORPORATION_INFO,
    # Ship
    MY_STATUS,
    SHIP_DEFINITIONS,
    PURCHASE_SHIP,
    SELL_SHIP,
    RENAME_SHIP,
    # Info
    EVENT_QUERY,
    LEADERBOARD_RESOURCES,
    LOAD_GAME_INFO,
    # Combat
    COMBAT_INITIATE,
    COMBAT_ACTION,
    # Messaging
    SEND_MESSAGE,
    RENAME_CORPORATION,
    # Task management
    START_TASK,
    STOP_TASK,
    STEER_TASK,
    QUERY_TASK_PROGRESS,
    # Task special
    WAIT_IN_IDLE_STATE,
    TASK_FINISHED,
)

# VoiceAgent: conversational tools including combat and task management
VOICE_TOOLS = ToolsSchema(
    [
        # Info / queries
        MY_STATUS,
        PLOT_COURSE,
        LIST_KNOWN_PORTS,
        CORPORATION_INFO,
        LEADERBOARD_RESOURCES,
        SHIP_DEFINITIONS,
        LOAD_GAME_INFO,
        # Direct actions
        RENAME_SHIP,
        RENAME_CORPORATION,
        SEND_MESSAGE,
        # Combat
        COMBAT_INITIATE,
        COMBAT_ACTION,
        # Task management
        START_TASK,
        STOP_TASK,
        STEER_TASK,
        QUERY_TASK_PROGRESS,
    ]
)

# TaskAgent: autonomous game actions (no combat, no meta-task, no conversational)
TASK_TOOLS = ToolsSchema(
    [
        # Navigation
        MOVE,
        PLOT_COURSE,
        MY_MAP,
        LOCAL_MAP_REGION,
        PATH_WITH_REGION,
        # Trading
        TRADE,
        LIST_KNOWN_PORTS,
        SALVAGE_COLLECT,
        DUMP_CARGO,
        # Resources
        RECHARGE_WARP_POWER,
        PURCHASE_FIGHTERS,
        TRANSFER_WARP_POWER,
        TRANSFER_CREDITS,
        BANK_DEPOSIT,
        BANK_WITHDRAW,
        PLACE_FIGHTERS,
        COLLECT_FIGHTERS,
        # Corporation
        CREATE_CORPORATION,
        JOIN_CORPORATION,
        LEAVE_CORPORATION,
        KICK_CORPORATION_MEMBER,
        CORPORATION_INFO,
        # Ship
        MY_STATUS,
        SHIP_DEFINITIONS,
        PURCHASE_SHIP,
        SELL_SHIP,
        # Info
        EVENT_QUERY,
        LEADERBOARD_RESOURCES,
        LOAD_GAME_INFO,
        # Task special
        WAIT_IN_IDLE_STATE,
        TASK_FINISHED,
    ]
)
