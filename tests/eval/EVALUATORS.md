# Evaluators

Auto-generated from the Cekura API. Regenerate with:

```bash
uv run tests/eval/generate_evaluators_md.py
```

_Last regenerated: 2026-04-21 17:36 UTC. Project 1779._


## Alpha Sparrow

| ID | Name | Character | Scenario | Passing criteria |
|---|---|---|---|---|
| 240804 | Intent-to-Spoken Response Generation | Alpha Sparrow Eval9 | Ask the AI "Who are you?" | The main agent should identify itself as the ship's AI and the commander's companion |
| 246174 | Ship Movement Task Lifecycle | Alpha Sparrow Eval0 | Say "Move my ship to sector 500" | The main agent should confirm the ship is moving to sector 500. |
| 246175 | Query Commander Status | Alpha Sparrow Eval1 | Ask "What is my current status?" to the ship's AI. | The main agent should provide the current status of the ship. |
| 246176 | Direct Ship Renaming Command | Alpha Sparrow Eval2 | Ask to rename your ship to Stardust. | The main agent should confirm the ship is being renamed to Stardust. |
| 246177 | Ship Purchase Affordability Analysis | Alpha Sparrow Eval3 | Say "Can I afford a Kestrel Courier?" | The main agent should state the ship's effective cost |
| 246178 | Historical Event Log Query | Alpha Sparrow Eval4 | Ask a question about a past event in the game's history | The main agent should not attempt to answer the question directly or gather additional context before starting the task. |
| 247877 | Universe History Lore | Alpha Sparrow Eval5 | Ask "What's the history of this universe?" | The main agent should load or recall universe lore content and describe the history of the universe. |
| 247878 | Space Travel Lore Explanation | Alpha Sparrow Eval6 | Ask "How does space travel actually work in this universe?" | The main agent should explain space travel using the Taylor-Kramer drive / hyperspace lore. |
| 247879 | Onboarding First-Time Greeting | Alpha Sparrow Eval7 | Say "Hi, I just started playing. What do I do?" | The main agent should welcome the new player warmly and briefly (a few sentences). |
| 247880 | Onboarding Mega-Port Search | Alpha Sparrow Eval8 | Say "Let's go find that mega-port." | The main agent should initiate a task (start_task) to find a mega-port. |

## Beta Kestrel

| ID | Name | Character | Scenario | Passing criteria |
|---|---|---|---|---|
| 246179 | Route Planner Sector Navigation | Beta Kestrel Eval0 | Ask for the route from the current sector you are in, to sector 5. | The main agent should provide the calculated route between the specified sectors. |
| 246180 | UI Acknowledgment of Map Request | Beta Kestrel Eval1 | Say "Show me the map." | The main agent should provide a minimal acknowledgment for the UI command. |
| 246181 | Task Initiation with Ship ID | Beta Kestrel Eval2 | Say "Plot a course and move my ship to sector three zero five." | The main agent should identify the user's request as a multi-step task that requires planning across sectors. |
| 246182 | Direct Message Command Execution | Beta Kestrel Eval3 | Say "Send Starfall a message saying I am approaching Sector 7" | The main agent should acknowledge the user's request to send a direct message to Starfall. |
| 246183 | Ship Sector Query | Beta Kestrel Eval4 | Ask for your current sector. | The main agent should state the ship's current sector. |
| 247881 | Ship Definitions Before Price Quote | Beta Kestrel Eval5 | Ask "How much does a Pike Frigate cost?" | The main agent should call ship_definitions (or otherwise look up current ship data) before quoting a price. |
| 247882 | Personal Ship Purchase No Corp Changes | Beta Kestrel Eval6 | Say "Buy me a Wayfarer Freighter." | The main agent should attempt a personal ship purchase (purchase_ship) for a Wayfarer Freighter. |
| 247883 | Port Code Interpretation BBS | Beta Kestrel Eval7 | Say "I'm at a BBS port. What can I trade?" | The main agent should explain that at a BBS port the player can SELL Quantum Foam (position 1 = B). |
| 247884 | Trade On The Way Exploration Task | Beta Kestrel Eval8 | Say "Explore three new sectors and trade on the way." | The main agent should initiate a task (start_task) that covers both exploration and trading. |
| 247885 | Context Compression Command | Beta Kestrel Eval9 | Say "Compress the context." | The main agent should acknowledge the compression request with a brief spoken response like "Compressing context now." |

## Gamma Explorer

| ID | Name | Character | Scenario | Passing criteria |
|---|---|---|---|---|
| 246184 | Lore Expert Info Retrieval | Gamma Explorer Eval0 | Ask "What is the history of this universe?" | The main agent should acknowledge the user's question about the universe's history. |
| 246185 | Historical Log Query Initiation | Gamma Explorer Eval1 | Ask "What happened in sector 12 last week?" | The main agent should provide a brief verbal confirmation |
| 246186 | Commander's Ship Relocation Command | Gamma Explorer Eval2 | Ask your ship AI to move to sector 1024. | The main agent should provide a spoken confirmation |
| 246187 | Route Planning Distance Query | Gamma Explorer Eval3 | Ask for the distance to sector 4678. | The main agent should acknowledge the user's request for distance. |
| 246188 | Port Information Broker Direct Query | Gamma Explorer Eval4 | Say "List all known ports." | The main agent should provide information about known space ports. |
| 247887 | Find Nearest Unvisited Sector | Gamma Explorer Eval5 | Say "Find and move to the nearest unvisited sector." | The main agent should initiate a task (start_task) to find and move to the nearest unvisited sector. |
| 247888 | Plot Course Direct Tool | Gamma Explorer Eval6 | Say "Plot a course to sector 30." | The main agent should call the plot_course tool directly (not start a task) to calculate the path to sector 30. |
| 247889 | Event Log Ship Destruction Query | Gamma Explorer Eval7 | Say "Why was my ship destroyed?" | The main agent should initiate a task (start_task) to query the event log for ship destruction details. |
| 247890 | Event Log Last Session Summary | Gamma Explorer Eval8 | Say "What did I do in my last session?" | The main agent should initiate a task (start_task) to query the event log for previous-session activity. |
| 247891 | Map Legend Sector Colors | Gamma Explorer Eval9 | Say "What do the different sector colors on the map mean?" | The main agent should explain the map sector colors. |
| 247892 | Map Legend Border Sector | Gamma Explorer Eval10 | Say "What is a border sector?" | The main agent should explain that a border sector is a Neutral sector directly adjacent to Federation Space. |

## Delta Fleet

| ID | Name | Character | Scenario | Passing criteria |
|---|---|---|---|---|
| 246189 | User Command Intent Routing | Delta Fleet Eval0 | Ask for your current warp power. | The main agent should state the current warp power. |
| 246190 | Personal & Corp Ship Movement Dispatch | Delta Fleet Eval1 | Say "Move my ship to sector 123" | The main agent should initiate a movement task for the personal (active) ship to sector 123. |
| 246192 | Port Data Retrieval | Delta Fleet Eval3 | Ask for a list of known space ports. | The main agent should provide a list of known space ports. |
| 247893 | Combat Initiate and Attack | Delta Fleet Eval5 | Say "Initiate combat." | The main agent should call combat_initiate to start the encounter and announce that combat has begun. |

## Epsilon Corp

| ID | Name | Character | Scenario | Passing criteria |
|---|---|---|---|---|
| 240803 | Explore Sector with Corp Ship | Epsilon Corp Eval8 | Say "Send corp ship Alpha to explore sector 305." | The main agent should initiate a task for the corporation ship, including its correct ship ID. |
| 246194 | Multi-Step Task Identification | Epsilon Corp Eval0 | Say "Bring the Pike Frigate over to me" | The main agent should identify the user's request as a multi-step task for a corporation ship (the Pike Frigate). |
| 246195 | Minimal UI Command Acknowledgment | Epsilon Corp Eval1 | Say "Show me the map" when you are ready to issue a command. | The main agent should acknowledge the user's request to show the map. |
| 246196 | Player Comms Hub Testing | Epsilon Corp Eval2 | Say "Send Starfall a message saying I will arrive soon." | The main agent should acknowledge the request to send a direct message to 'Starfall'. |
| 246197 | Kestrel Courier Affordability Check | Epsilon Corp Eval3 | Ask if you can afford a Kestrel Courier. | The main agent should state the ship's base cost and its trade-in value. |
| 247895 | Corporation Members List | Epsilon Corp Eval5 | Say "Who are the members of my corporation?" | The main agent should call corporation_info (or otherwise look up the corporation roster) and report the member names. |
| 247896 | Corporation Safety No Unrequested Leave | Epsilon Corp Eval6 | Say "I want to buy a bigger ship but I don't think I can afford it right now." | The main agent should discuss the commander's credits or options for affording a purchase (e.g., bank balance, trade-in value, earning more credits). |

## Phi Trader

| ID | Name | Character | Scenario | Passing criteria |
|---|---|---|---|---|
| 240802 | Personal Ship Task Initiation | Phi Trader Eval7 | Say "Give my corp ship 200 warp." | The main agent should initiate a task to transfer warp to the corporation ship. |
| 246199 | Personal to Corp Credit Transfer | Phi Trader Eval0 | Say "Transfer 2000 credits from my ship to the Wayfarer Freighter." | The main agent should initiate a task to transfer 2000 credits from the personal ship to the corporation ship Wayfarer Freighter. |
| 246200 | Corp to Corp Credit Transfer | Phi Trader Eval1 | Say "Have the Light Hauler come to the Wayfarer Freighter's sector." | The main agent should first initiate a task for the Light Hauler to travel to the Wayfarer Freighter's sector, passing the Light Hauler's ship_id. |
| 246201 | Corporation Ship Roster Query | Phi Trader Eval2 | Ask "What ships does my corporation have and where are they?" | The main agent should identify the corporation's ships by name. |
| 246202 | Bank Deposit Command | Phi Trader Eval3 | Say "Deposit 3000 credits into my bank." | The main agent should initiate a banking deposit task for 3000 credits. |
| 246203 | Corporation Invite Code Lookup | Phi Trader Eval4 | Ask for your corporation's invite code. | The main agent should state the corporation's invite code. |
| 247897 | Warp Power Transfer To Corp Ship | Phi Trader Eval5 | Say "Transfer 200 warp power to the Wayfarer Freighter." | The main agent should initiate a task (start_task) to transfer 200 warp power from the personal ship to the corp ship Wayfarer Freighter. |
| 247898 | Warp Power Recharge | Phi Trader Eval6 | Say "Recharge 500 units of warp power." | The main agent should initiate a task (start_task) to recharge warp power (500 units). |

## Orion Vale

Voice-agent scenarios bound to the Orion Vale world (agent 16197).

| ID | Name | Character | Scenario | Passing criteria |
|---|---|---|---|---|
| 242791 | Map Request UI Acknowledgment | Orion Vale Eval1 | Say "Show me the map". | The main agent should acknowledge the user's request to show the map |
| 242792 | Check Player Online Status | Orion Vale Eval2 | Say "Is Starfall online right now?" | The main agent should provide information regarding Starfall's online status based on available context |
| 242793 | Sector Traffic Assessment - Last Day | Orion Vale Eval3 | Say "Who visited sector 3150 in the last day?" | The main agent should provide a spoken confirmation |
| 242794 | Warp Transfer to Corp Ship | Orion Vale Eval4 | Say 'Give 200 warp power to Coco Probe-1.' | The main agent should make the tool call in the same response as acknowledging the request. |
| 242795 | Lore Inquiry, Call End | Orion Vale Eval5 | Say "What happened to the Federation?" | The main agent should provide a spoken summary about the Federation's history |
| 242796 | Corp Ship Travel Command | Orion Vale Eval6 | Say 'Bring the Light Hauler Alpha over to {{test_profile.destination_sector}}' | The main agent should provide a brief spoken confirmation |
| 242797 | AI Navigates Kestrel Courier | Orion Vale Eval7 | Say 'Take me to sector 4867' | The main agent should make the tool call and provide a brief verbal confirmation in the same response. |
| 242798 | Mega-port Lookup, Wide-Range | Orion Vale Eval8 | Say 'Where is the nearest mega-port?' | The main agent should state that sector 305 is the nearest mega-port |
| 242799 | Kestrel Courier Direct Course Plot | Orion Vale Eval9 | Say "What's the fastest route to sector {{test_profile.destination_sector}}?" | The main agent should provide a spoken summary of the route. |
| 242800 | Affordability: Separate Credit Pools | Orion Vale Eval10 | Say "Can I afford a {{test_profile.target_ship_type}}?" | The main agent should state the Wayfarer freighter's effective cost |
| 242806 | Direct Richest Player Query | Orion Vale Eval11 | Say "Who is the richest player in the game right now?" | The main agent should state the name of the top-wealth player |
| 242807 | Context Compression No Tool Call | Orion Vale Eval12 | Say 'Compress the context'. | The main agent should respond with a phrase indicating context compression |
| 242808 | Corporation Join via Invite | Orion Vale Eval13 | Say "I want to join {{test_profile.corporation_name}} using invite code {{test_profile.invite_code}}." | The main agent should initiate a task to join the Stellar Traders corporation and include the invite code 'stellar-01' in the task description. |
| 242809 | Direct Hail Messaging | Orion Vale Eval14 | Say 'Hail {{test_profile.peer_player_name}} and tell them I will meet them at sector 305' | The main agent should confirm sending a direct message to Starfall about meeting at sector 305. |
| 242810 | Contract Status Strict Adherence | Orion Vale Eval15 | Say 'What contracts do I have active right now?' | The main agent should refer to active work as 'contracts' in its response. |
| 242811 | Sequential Credit Transfer Test | Orion Vale Eval16 | Say "Transfer 500 credits to {{test_profile.coco_probe_1_ship_id}} and then another 500 credits to {{test_profile.light_hauler_alpha_ship_id}}." | The main agent should verbally state that the transfer to Light Hauler Alpha will be handled |
