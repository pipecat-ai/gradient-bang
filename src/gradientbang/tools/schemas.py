"""Shared FunctionSchema definitions for all game tools.

Single source of truth for tool schemas used by both VoiceAgent and TaskAgent.
Grouped by domain. Each schema is a module-level FunctionSchema constant.
"""

from pipecat.adapters.schemas.function_schema import FunctionSchema

# ── Navigation ────────────────────────────────────────────────────────

MOVE = FunctionSchema(
    name="move",
    description="Move your ship to an adjacent sector. You can only move one sector at a time.",
    properties={
        "to_sector": {
            "type": "integer",
            "description": "Adjacent sector ID to move to",
        }
    },
    required=["to_sector"],
)

PLOT_COURSE = FunctionSchema(
    name="plot_course",
    description="Calculate shortest path from your current sector (or an optional from_sector) to the destination",
    properties={
        "to_sector": {
            "type": "integer",
            "description": "Destination sector ID",
            "minimum": 0,
        },
        "from_sector": {
            "type": "integer",
            "description": (
                "Starting sector ID (defaults to your current sector). "
                "Must be a sector you or your corporation have discovered."
            ),
            "minimum": 0,
        },
    },
    required=["to_sector"],
)

MY_MAP = FunctionSchema(
    name="my_map",
    description="Get your map knowledge including all visited sectors, known ports, and discovered connections",
    properties={},
    required=[],
)

LOCAL_MAP_REGION = FunctionSchema(
    name="local_map_region",
    description="Get all known sectors around current location for local navigation and awareness. Shows visited sectors with full details (ports, adjacents, position) and nearby unvisited sectors seen in adjacency lists.",
    properties={
        "center_sector": {
            "type": "integer",
            "description": "Optional center sector; defaults to current sector",
            "minimum": 0,
        },
        "max_hops": {
            "type": "integer",
            "description": "Maximum BFS depth (default 3, max 10)",
            "minimum": 1,
            "maximum": 10,
            "default": 3,
        },
        "max_sectors": {
            "type": "integer",
            "description": "Maximum sectors to return (default 100)",
            "minimum": 1,
            "default": 100,
        },
    },
    required=[],
)

PATH_WITH_REGION = FunctionSchema(
    name="path_with_region",
    description="Get path to destination plus local context around each path node for route visualization. Shows path, nearby known sectors, and identifies potential hazards or alternatives along the route.",
    properties={
        "to_sector": {
            "type": "integer",
            "description": "Destination sector ID",
            "minimum": 0,
        },
        "region_hops": {
            "type": "integer",
            "description": "How many hops around each path node (default 1)",
            "minimum": 0,
            "maximum": 3,
            "default": 1,
        },
        "max_sectors": {
            "type": "integer",
            "description": "Total sector limit (default 200)",
            "minimum": 1,
            "default": 200,
        },
    },
    required=["to_sector"],
)

# ── Trading ───────────────────────────────────────────────────────────

TRADE = FunctionSchema(
    name="trade",
    description=(
        "Execute a trade at the current port. BEFORE CALLING, check your status info: "
        "(1) Port code (e.g., BBS): position 1=QF, 2=RO, 3=NS. B=you SELL, S=you BUY. "
        "(2) Empty holds: if 0, do NOT attempt to buy. "
        "(3) Your cargo: only sell what you have. "
        "Example: Port BBS means SELL QF (B), SELL RO (B), BUY NS (S). "
        "Always SELL first to free holds before buying."
    ),
    properties={
        "commodity": {
            "type": "string",
            "enum": ["quantum_foam", "retro_organics", "neuro_symbolics"],
            "description": "The commodity to trade",
        },
        "quantity": {
            "type": "integer",
            "description": "Amount to trade",
            "minimum": 1,
        },
        "trade_type": {
            "type": "string",
            "enum": ["buy", "sell"],
            "description": (
                "Your action: 'buy' to purchase FROM the port (port must have S for that commodity), "
                "'sell' to sell TO the port (port must have B for that commodity)"
            ),
        },
    },
    required=["commodity", "quantity", "trade_type"],
)

LIST_KNOWN_PORTS = FunctionSchema(
    name="list_known_ports",
    description="Find all known ports within travel range for trading/planning. Useful for finding nearest port of specific type, mega-ports for services, or ports that buy/sell specific commodities.",
    properties={
        "from_sector": {
            "type": "integer",
            "description": "Optional starting sector; defaults to current sector",
            "minimum": 0,
        },
        "max_hops": {
            "type": "integer",
            "description": "Maximum hop distance (max 100). Default is only 5 hops — use max_hops=100 when the user asks for all known ports or doesn't specify a range.",
            "minimum": 0,
            "maximum": 100,
        },
        "port_type": {
            "type": "string",
            "description": "Optional filter by port code (e.g., 'BBB', 'SSS', 'BBS')",
        },
        "commodity": {
            "type": "string",
            "enum": ["quantum_foam", "retro_organics", "neuro_symbolics"],
            "description": "Optional filter ports that trade this commodity",
        },
        "trade_type": {
            "type": "string",
            "enum": ["buy", "sell"],
            "description": "Optional 'buy' or 'sell' (requires commodity). 'buy' finds ports that sell to you, 'sell' finds ports that buy from you.",
        },
        "mega": {
            "type": "boolean",
            "description": "Filter by mega-port status. Set true to find only mega-ports (warp recharge, banking, armory). Set false for regular ports only.",
        },
    },
    required=[],
)

SALVAGE_COLLECT = FunctionSchema(
    name="salvage_collect",
    description="Collect salvage by salvage ID in the current sector.",
    properties={
        "salvage_id": {
            "type": "string",
            "description": "Identifier of the salvage container to collect",
        }
    },
    required=["salvage_id"],
)

DUMP_CARGO = FunctionSchema(
    name="dump_cargo",
    description=(
        "Jettison cargo into space to create salvage in the current sector. "
        "Dumped cargo is lost from your hold. "
        'Example: dump_cargo({"items": [{"commodity": "quantum_foam", "units": 1}]})'
    ),
    properties={
        "items": {
            "type": "array",
            "description": "List of cargo entries to dump. Each entry requires a commodity and units.",
            "items": {
                "type": "object",
                "properties": {
                    "commodity": {
                        "type": "string",
                        "enum": [
                            "quantum_foam",
                            "retro_organics",
                            "neuro_symbolics",
                        ],
                    },
                    "units": {
                        "type": "integer",
                        "minimum": 1,
                    },
                },
                "required": ["commodity", "units"],
            },
            "minItems": 1,
        }
    },
    required=["items"],
)

# ── Resources ─────────────────────────────────────────────────────────

RECHARGE_WARP_POWER = FunctionSchema(
    name="recharge_warp_power",
    description="Recharge warp power at a mega-port in Federation Space (2 credits per unit)",
    properties={
        "units": {
            "type": "integer",
            "description": "Number of warp power units to recharge",
            "minimum": 1,
        }
    },
    required=["units"],
)

PURCHASE_FIGHTERS = FunctionSchema(
    name="purchase_fighters",
    description="Buy fighters at a mega-port armory in Federation Space (50 credits each; requires available fighter capacity).",
    properties={
        "units": {
            "type": "integer",
            "description": "Number of fighters to purchase",
            "minimum": 1,
        }
    },
    required=["units"],
)

TRANSFER_WARP_POWER = FunctionSchema(
    name="transfer_warp_power",
    description=(
        "Transfer warp power to another ship in the same sector. Provide one of "
        "to_player_name, to_ship_id, or to_ship_name. For corporation ships, "
        "use corporation_info to find the ship_id. to_ship_id accepts a full UUID "
        "or a 6-8 hex prefix (unique in the current sector). If you see a name like "
        "'Fast Probe [abcd1234]', the bracket suffix is just a short id. If the "
        "recipient reaches full warp capacity mid-transfer, the event may reflect a "
        "successful partial transfer rather than a total failure."
    ),
    properties={
        "to_player_name": {
            "type": "string",
            "description": "Display name of the recipient currently in your sector",
            "minLength": 1,
        },
        "to_ship_id": {
            "type": "string",
            "description": "Ship UUID or 6-8 hex prefix for the recipient ship",
        },
        "to_ship_name": {
            "type": "string",
            "description": "Unique ship name for the recipient ship (without bracket suffix)",
            "minLength": 1,
        },
        "units": {
            "type": "integer",
            "description": "Number of warp power units to transfer",
            "minimum": 1,
        },
    },
    required=["units"],
)

TRANSFER_CREDITS = FunctionSchema(
    name="transfer_credits",
    description=(
        "Transfer on-hand credits to another ship in the same sector. Provide "
        "one of to_player_name, to_ship_id, or to_ship_name. For corporation ships, "
        "use corporation_info to find the ship_id. to_ship_id accepts a full UUID "
        "or a 6-8 hex prefix (unique in the current sector). If you see a name like "
        "'Fast Probe [abcd1234]', the bracket suffix is just a short id."
    ),
    properties={
        "to_player_name": {
            "type": "string",
            "description": "Display name of the recipient currently in your sector",
            "minLength": 1,
        },
        "to_ship_id": {
            "type": "string",
            "description": "Ship UUID or 6-8 hex prefix for the recipient ship",
        },
        "to_ship_name": {
            "type": "string",
            "description": "Unique ship name for the recipient ship (without bracket suffix)",
            "minLength": 1,
        },
        "amount": {
            "type": "integer",
            "description": "Number of credits to transfer",
            "minimum": 1,
        },
    },
    required=["amount"],
)

BANK_DEPOSIT = FunctionSchema(
    name="bank_deposit",
    description=(
        "Deposit ship credits into a mega-port bank account in Federation Space. "
        "Provide your active ship automatically or specify a corporation ship. "
        "You may only deposit to yourself or (when in the same corporation) to another member. "
        "The target must be a player/member character name, not a corporation ship name like 'Corp Ship [abcd12]'."
    ),
    properties={
        "amount": {
            "type": "integer",
            "description": "Number of credits to deposit",
            "minimum": 1,
        },
        "ship_id": {
            "type": "string",
            "description": "ID (or 6-8 hex prefix) of the ship funding the deposit (omit to use your active ship)",
        },
        "ship_name": {
            "type": "string",
            "description": "Name of the ship funding the deposit (omit to use your active ship)",
        },
        "character_id": {
            "type": "string",
            "description": "Character initiating the deposit (defaults to the authenticated pilot)",
        },
        "target_player_name": {
            "type": "string",
            "description": "Display name of the bank account owner receiving the deposit",
            "minLength": 1,
        },
    },
    required=["amount", "target_player_name"],
)

BANK_WITHDRAW = FunctionSchema(
    name="bank_withdraw",
    description="Withdraw credits from your own mega-port bank account in Federation Space back onto your ship. Only available for personal ships — corporation ships cannot withdraw.",
    properties={
        "amount": {
            "type": "integer",
            "description": "Number of credits to withdraw",
            "minimum": 1,
        },
        "character_id": {
            "type": "string",
            "description": "Character withdrawing funds (defaults to the authenticated pilot)",
        },
    },
    required=["amount"],
)

PLACE_FIGHTERS = FunctionSchema(
    name="place_fighters",
    description="Leave fighters behind in the current sector as a garrison. Not allowed in Federation Space or border sectors (Neutral sectors with a direct warp to Federation Space).",
    properties={
        "sector": {
            "type": "integer",
            "description": "Sector ID where fighters will be stationed",
            "minimum": 0,
        },
        "quantity": {
            "type": "integer",
            "description": "Number of fighters to leave behind",
            "minimum": 1,
        },
        "mode": {
            "type": "string",
            "enum": ["offensive", "defensive", "toll"],
            "description": "Behavior mode for stationed fighters",
            "default": "offensive",
        },
        "toll_amount": {
            "type": "integer",
            "description": "Credits required to pass when mode is toll",
            "minimum": 0,
            "default": 0,
        },
    },
    required=["sector", "quantity"],
)

COLLECT_FIGHTERS = FunctionSchema(
    name="collect_fighters",
    description="Retrieve fighters previously stationed in the current sector.",
    properties={
        "sector": {
            "type": "integer",
            "description": "Sector ID to collect fighters from",
            "minimum": 0,
        },
        "quantity": {
            "type": "integer",
            "description": "Number of fighters to retrieve",
            "minimum": 1,
        },
    },
    required=["sector", "quantity"],
)

SET_GARRISON_MODE = FunctionSchema(
    name="set_garrison_mode",
    description="Change the operating mode of a garrison in a sector. Only works on your own garrison or a corp mate's garrison.",
    properties={
        "sector": {
            "type": "integer",
            "description": "Sector ID containing the garrison",
            "minimum": 0,
        },
        "mode": {
            "type": "string",
            "enum": ["offensive", "defensive", "toll"],
            "description": "New behavior mode for the garrison",
        },
        "toll_amount": {
            "type": "integer",
            "description": "Credits required to pass when mode is toll",
            "minimum": 0,
            "default": 0,
        },
    },
    required=["sector", "mode"],
)

DISBAND_GARRISON = FunctionSchema(
    name="disband_garrison",
    description=(
        "Permanently destroy a garrison, removing all stationed fighters. "
        "Fighters are NOT recovered. Any accumulated toll credits are collected. "
        "Always prefer collect_fighters to recover fighters first; only use this "
        "tool when your ship cannot hold more fighters and you need the garrison removed."
    ),
    properties={
        "sector": {
            "type": "integer",
            "description": "Sector ID containing the garrison to disband",
            "minimum": 0,
        },
    },
    required=["sector"],
)

# ── Corporation ───────────────────────────────────────────────────────

CREATE_CORPORATION = FunctionSchema(
    name="create_corporation",
    description="Create a new corporation. Requires sufficient ship credits for the founding fee.",
    properties={
        "name": {
            "type": "string",
            "description": "Corporation name (3-50 characters)",
            "minLength": 3,
            "maxLength": 50,
        },
        "character_id": {
            "type": "string",
            "description": "Character founding the corporation (defaults to the authenticated pilot)",
        },
    },
    required=["name"],
)

JOIN_CORPORATION = FunctionSchema(
    name="join_corporation",
    description="Join an existing corporation using an invite code.",
    properties={
        "corp_id": {
            "type": "string",
            "description": "Corporation identifier to join",
            "minLength": 1,
        },
        "corp_name": {
            "type": "string",
            "description": "Corporation display name to join (case-insensitive). Ignored if corp_id is provided.",
            "minLength": 1,
        },
        "invite_code": {
            "type": "string",
            "description": "Invite code provided by the corporation",
            "minLength": 1,
        },
        "character_id": {
            "type": "string",
            "description": "Character joining the corporation (defaults to the authenticated pilot)",
        },
    },
    required=["invite_code"],
)

LEAVE_CORPORATION = FunctionSchema(
    name="leave_corporation",
    description=(
        "Leave your current corporation. High-stakes action, confirm with the user before calling. "
        "You lose corporation access and would need a new invite to rejoin. "
        "Corporation ships you own remain with the corporation and are not lost, but you lose access to them until you rejoin. "
        "Note: if you are the last member, the corporation is automatically disbanded and any remaining assets are lost."
    ),
    properties={
        "character_id": {
            "type": "string",
            "description": "Character leaving the corporation (defaults to the authenticated pilot)",
        },
    },
    required=[],
)

KICK_CORPORATION_MEMBER = FunctionSchema(
    name="kick_corporation_member",
    description=(
        "Remove another member from your corporation. "
        "They lose corporation access and need a new invite to rejoin."
    ),
    properties={
        "target_id": {
            "type": "string",
            "description": "Character ID of the member to remove",
            "minLength": 1,
        },
        "character_id": {
            "type": "string",
            "description": "Character executing the kick (defaults to the authenticated pilot)",
        },
    },
    required=["target_id"],
)

CORPORATION_INFO = FunctionSchema(
    name="corporation_info",
    description="Get corporation information. By default returns your own corporation's info including members and ships. Can also look up a specific corporation by ID, or list all corporations.",
    properties={
        "list_all": {
            "type": "boolean",
            "description": "Set to true to list all corporations in the game",
        },
        "corp_id": {
            "type": "string",
            "description": "Look up a specific corporation by its ID. Omit to get your own corporation's info.",
        },
    },
    required=[],
)

# ── Ship ──────────────────────────────────────────────────────────────

MY_STATUS = FunctionSchema(
    name="my_status",
    description="Get a snapshot of your current live state (ship, sector, cargo, credits). Does not contain any historical data.",
    properties={},
    required=[],
)

SHIP_DEFINITIONS = FunctionSchema(
    name="ship_definitions",
    description=(
        "Get all ship type definitions from the database including current prices, "
        "cargo capacity, warp power, shields, and fighters. "
        "You MUST call this before quoting any ship price or purchasing a ship. "
        "Never guess or assume prices; they come only from this tool."
    ),
    properties={},
    required=[],
)

PURCHASE_SHIP = FunctionSchema(
    name="purchase_ship",
    description=(
        "Purchase a ship for personal use or on behalf of your corporation. "
        "Personal purchases use ship credits (with trade-in value from current ship). "
        "Corporation purchases also use your ship credits and may seed initial ship credits into the new corp ship. "
        "If ship_name is omitted, the default display name is used and auto-suffixed "
        "for uniqueness. "
        "Note: autonomous ships (autonomous_probe, autonomous_light_hauler) can ONLY be "
        "purchased for corporations, not for personal use. "
        "IMPORTANT: You must call ship_definitions() before purchasing to get "
        "accurate prices. Pass the exact base price as expected_price."
    ),
    properties={
        "ship_type": {
            "type": "string",
            "enum": [
                "kestrel_courier",
                "sparrow_scout",
                "parhelion_seeker",
                "wayfarer_freighter",
                "pioneer_lifter",
                "atlas_hauler",
                "corsair_raider",
                "pike_frigate",
                "bulwark_destroyer",
                "aegis_cruiser",
                "sovereign_starcruiser",
                "autonomous_probe",
                "autonomous_light_hauler",
            ],
            "description": (
                "Ship type to purchase. Autonomous types (autonomous_probe, "
                "autonomous_light_hauler) are corporation-only."
            ),
        },
        "expected_price": {
            "type": "integer",
            "description": (
                "The exact base purchase price for this ship type (before trade-in). "
                "Get this from ship_definitions(). "
                "The server will reject the purchase if this does not match."
            ),
            "minimum": 0,
        },
        "purchase_type": {
            "type": "string",
            "enum": ["personal", "corporation"],
            "description": "Whether this purchase is personal or for the corporation (default personal).",
        },
        "ship_name": {
            "type": "string",
            "description": "Optional display name for the new ship",
            "minLength": 1,
        },
        "trade_in_ship_id": {
            "type": "string",
            "description": "Ship ID to trade in when making a personal purchase",
        },
        "corp_id": {
            "type": "string",
            "description": "Corporation ID when purchasing for a corporation (defaults to your membership)",
        },
        "initial_ship_credits": {
            "type": "integer",
            "description": "Credits to seed into the new corp ship (deducted from your ship credits along with the price)",
            "minimum": 0,
        },
        "character_id": {
            "type": "string",
            "description": "Character executing the purchase (defaults to the authenticated pilot)",
        },
    },
    required=["ship_type", "expected_price"],
)

SELL_SHIP = FunctionSchema(
    name="sell_ship",
    description=(
        "Sell a corporation ship. The ship is removed and trade-in value is returned as credits. "
        "Only works at a mega-port. You cannot sell your personal ship. "
        "Call corporation_info() first to find the ship and its short ID shown in brackets "
        "(e.g. [5606a3]), and ship_definitions() for pricing."
    ),
    properties={
        "ship_id": {
            "type": "string",
            "description": (
                "Ship ID to sell. Use the short hex prefix shown in brackets "
                "by corporation_info() (e.g. '5606a3')."
            ),
        },
        "character_id": {
            "type": "string",
            "description": "Character executing the sale (defaults to the authenticated pilot)",
        },
    },
    required=["ship_id"],
)

RENAME_SHIP = FunctionSchema(
    name="rename_ship",
    description=(
        "Rename a ship you own. For corporation ships, call corporation_info() "
        "to find the ship_id. ship_id accepts a full UUID or a 6-8 hex prefix "
        "(must uniquely identify a ship you control)."
    ),
    properties={
        "ship_name": {
            "type": "string",
            "description": "New display name for the ship",
            "minLength": 1,
        },
        "ship_id": {
            "type": "string",
            "description": (
                "Corporation ship UUID or 6-8 hex prefix to rename. "
                "Omit this to rename your own active ship."
            ),
        },
    },
    required=["ship_name"],
)

# ── Info ──────────────────────────────────────────────────────────────

EVENT_QUERY = FunctionSchema(
    name="event_query",
    description=(
        "Query the event log for a time range. Returns up to 100 events per call. "
        "Response includes 'has_more' (boolean) and 'next_cursor' (event ID) for pagination. "
        "To get more results, call again with cursor=next_cursor from the previous response."
    ),
    properties={
        "start": {
            "type": "string",
            "description": "ISO8601 timestamp (inclusive start of range)",
        },
        "end": {
            "type": "string",
            "description": "ISO8601 timestamp (exclusive end of range)",
        },
        "admin_password": {
            "type": "string",
            "description": "Optional admin password when required for wider queries",
        },
        "character_id": {
            "type": "string",
            "description": "Character ID for permissions (who is querying). Auto-injected if not provided.",
        },
        "corporation_id": {
            "type": "string",
            "description": "Corporation ID for scope (view corp events)",
        },
        "cursor": {
            "type": "integer",
            "description": (
                "Pagination cursor (event ID). For forward sort, returns events after this ID. "
                "For reverse sort, returns events before this ID. "
                "Use the 'next_cursor' value from a previous response to get the next page."
            ),
        },
        "filter_sector": {
            "type": "integer",
            "description": "Filter to events within a sector",
            "minimum": 0,
        },
        "filter_task_id": {
            "type": "string",
            "description": (
                "Filter to events from a specific task. Accepts full UUID or short ID "
                "(first 6 hex chars, e.g., '6c4393'). Short IDs appear in event summaries as [task=6c4393]."
            ),
        },
        "filter_event_type": {
            "type": "string",
            "description": "Filter to a specific event type. e.g., 'session.started', 'task.start', 'task.finish', 'movement.complete' (for player's own movements), 'garrison.character_moved' (for monitoring events in a sector where we have placed fighters)",
        },
        "filter_string_match": {
            "type": "string",
            "description": "Optional literal substring to search for within event payloads",
        },
        "max_rows": {
            "type": "integer",
            "description": "Maximum number of events to return (defaults to 100, max 100)",
            "minimum": 1,
            "maximum": 100,
        },
        "sort_direction": {
            "type": "string",
            "enum": ["forward", "reverse"],
            "description": "Return events in chronological order ('forward') or reverse chronological order ('reverse'). Defaults to forward.",
        },
        "event_scope": {
            "type": "string",
            "enum": ["personal", "corporation"],
            "description": (
                "Scope of events to query. Defaults to 'personal' (your own events, plus "
                "events explicitly delivered to you via visibility rules, including "
                "garrison visibility events like garrison.character_moved). "
                "Use 'corporation' to see events for all corp members and corp-tagged events "
                "(e.g., corp ship tasks, shared trade history). Falls back to personal if not in a corp."
            ),
        },
    },
    required=["start", "end"],
)

LEADERBOARD_RESOURCES = FunctionSchema(
    name="leaderboard_resources",
    description=(
        "Fetch the latest leaderboard snapshot. The response includes "
        "wealth, trading, exploration, and territory rankings."
    ),
    properties={
        "force_refresh": {
            "type": "boolean",
            "description": "Bypass the cached snapshot and fetch fresh leaderboard data.",
        },
    },
    required=[],
)

LOAD_GAME_INFO = FunctionSchema(
    name="load_game_info",
    description=(
        "Load detailed game information about a specific topic. "
        "Use when you need in-depth rules or mechanics."
    ),
    properties={
        "topic": {
            "type": "string",
            "enum": [
                "exploration",
                "trading",
                "combat",
                "corporations",
                "transfers",
                "ships",
                "event_logs",
                "map_legend",
                "lore",
            ],
            "description": "The topic to load detailed information about",
        },
    },
    required=["topic"],
)

# ── Combat ────────────────────────────────────────────────────────────

COMBAT_INITIATE = FunctionSchema(
    name="combat_initiate",
    description="Start a combat encounter in the current sector. Requires fighters aboard.",
    properties={
        "target_id": {
            "type": "string",
            "description": "Optional explicit target combatant identifier.",
        },
        "target_type": {
            "type": "string",
            "description": "Type of the specified target (default 'character').",
            "default": "character",
        },
    },
    required=[],
)

COMBAT_ACTION = FunctionSchema(
    name="combat_action",
    description=(
        "Submit your combat round decision. Valid actions: attack, brace, flee, or pay. "
        "Provide commit and target_id when attacking; include to_sector when fleeing."
    ),
    properties={
        "combat_id": {
            "type": "string",
            "description": "Active combat encounter identifier.",
        },
        "action": {
            "type": "string",
            "enum": ["attack", "brace", "flee", "pay"],
            "description": "Action to perform this round.",
        },
        "commit": {
            "type": "integer",
            "description": "Number of fighters to commit when attacking.",
            "minimum": 0,
        },
        "target_id": {
            "type": "string",
            "description": (
                "Target combatant identifier (required for attack). "
                "Use participant id from combat.round_waiting when available."
            ),
        },
        "to_sector": {
            "type": "integer",
            "description": "Destination sector when fleeing.",
        },
        "round_number": {
            "type": "integer",
            "description": "Optional round number hint for concurrency control.",
            "minimum": 1,
        },
    },
    required=["combat_id", "action"],
)

# ── Messaging ─────────────────────────────────────────────────────────

SEND_MESSAGE = FunctionSchema(
    name="send_message",
    description=(
        "Send an in-game message to another player. "
        "ONLY use when the commander explicitly asks to send a message, hail, or broadcast to another player. "
        "NEVER use to answer questions, check status, relay events, or respond to the commander. "
        "For direct messages, target by character name, ship name, or ship_id. "
        "to_ship_id accepts a full UUID or a 6-8 hex prefix."
    ),
    properties={
        "content": {
            "type": "string",
            "description": "Message text (max 512 chars)",
        },
        "msg_type": {
            "type": "string",
            "enum": ["broadcast", "direct"],
            "description": "broadcast = visible to ALL players; direct = private to one player",
        },
        "to_player": {
            "type": "string",
            "description": (
                "Recipient character name or ship name (required for direct unless using ship_id). "
                "Use this field for direct messages."
            ),
        },
        "to_ship_id": {
            "type": "string",
            "description": "Ship UUID or 6-8 hex prefix for the recipient ship (direct messages)",
        },
        "to_ship_name": {
            "type": "string",
            "description": "Ship name for the recipient ship (direct messages, no bracket suffix)",
        },
    },
    required=["content"],
)

RENAME_CORPORATION = FunctionSchema(
    name="rename_corporation",
    description="Rename your current corporation. Name must be 3-50 characters and unique.",
    properties={
        "name": {
            "type": "string",
            "description": "The new name for the corporation (3-50 characters)",
            "minLength": 3,
            "maxLength": 50,
        },
    },
    required=["name"],
)

# ── Task management (VoiceAgent only) ─────────────────────────────────

START_TASK = FunctionSchema(
    name="start_task",
    description=(
        "Start a complex multi-step task for navigation, trading, or exploration. "
        "Can control your own ship or a corporation ship. "
        "If a task is already running on the target ship, this call steers the "
        "existing task with the new description instead of starting a fresh one — "
        "the running task keeps its in-flight progress and reassesses with the "
        "new instructions on its next turn. Use stop_task explicitly if you need "
        "a clean slate."
    ),
    properties={
        "task_description": {
            "type": "string",
            "description": "Natural language description of the task to execute",
        },
        "context": {
            "type": "string",
            "description": "Relevant conversation history or clarifications",
        },
        "ship_id": {
            "type": "string",
            "description": (
                "Corporation ship ID to control. Only set this when the corp ship "
                "is the ACTOR performing the work (e.g., exploring, trading). "
                "OMIT ship_id when your personal ship is the actor — including "
                "transfers/gifts TO a corp ship. Accepts full UUID or short prefix "
                "(e.g., [5a8369])."
            ),
        },
    },
    required=["task_description"],
)

STOP_TASK = FunctionSchema(
    name="stop_task",
    description="Cancel a running task. If task_id is provided, cancels that specific task (full UUID or short prefix). Otherwise cancels your primary ship's task.",
    properties={
        "task_id": {
            "type": "string",
            "description": "Optional task ID to cancel a specific task (full UUID or short prefix, e.g., '8ea25c'). If not provided, cancels your primary ship's task.",
        },
    },
    required=[],
)

STEER_TASK = FunctionSchema(
    name="steer_task",
    description="Send a steering instruction to a running task.",
    properties={
        "task_id": {
            "type": "string",
            "description": "Task ID to steer (short ID or full UUID).",
        },
        "message": {
            "type": "string",
            "description": "Steering instruction to send to the task.",
        },
    },
    required=["task_id", "message"],
)

QUERY_TASK_PROGRESS = FunctionSchema(
    name="query_task_progress",
    description=(
        "Check on what a running or recently finished task is doing by querying its task log. "
        "For best results, include `prompt` with the user's exact question."
    ),
    properties={
        "task_id": {
            "type": "string",
            "description": (
                "Optional task ID to query (short ID or full UUID). "
                "If omitted, defaults to your primary ship's active task. "
                "For corp-ship tasks, pass the task_id returned by start_task or task.start."
            ),
        },
        "prompt": {
            "type": "string",
            "description": (
                "Optional question or instruction about task progress. "
                "Use the user's exact question when available. "
                "If omitted, a generic status update prompt is used."
            ),
        },
    },
    required=[],
)

# ── Task special (TaskAgent only) ─────────────────────────────────────

WAIT_IN_IDLE_STATE = FunctionSchema(
    name="wait_in_idle_state",
    description=(
        "Pause in an idle state while still listening for live events. "
        "Use only for long waits on external events (e.g., another player arriving "
        "or a chat.message). Do NOT use for movement/combat/trade completions. "
        "If no events arrive before the timeout, an idle.complete event is emitted."
    ),
    properties={
        "seconds": {
            "type": "integer",
            "description": "Seconds to remain idle (1-60). Defaults to 60.",
            "minimum": 1,
            "maximum": 60,
            "default": 60,
        }
    },
    required=[],
)

TASK_FINISHED = FunctionSchema(
    name="finished",
    description="Signal that you have completed the assigned task",
    properties={
        "message": {
            "type": "string",
            "description": "Completion message describing what was accomplished",
            "default": "Task completed",
        },
        "status": {
            "type": "string",
            "enum": ["completed", "failed"],
            "description": "Set to 'failed' if the task could not be completed due to errors or impossible conditions. Defaults to 'completed'.",
            "default": "completed",
        },
    },
    required=["message"],
)

# ── Game client method aliases ─────────────────────────────────────────
# When the tool name doesn't match the game_client method name.

GAME_METHOD_ALIASES = {
    "bank_deposit": "deposit_to_bank",
    "bank_withdraw": "withdraw_from_bank",
    "place_fighters": "combat_leave_fighters",
    "collect_fighters": "combat_collect_fighters",
    "set_garrison_mode": "combat_set_garrison_mode",
    "disband_garrison": "combat_disband_garrison",
}
