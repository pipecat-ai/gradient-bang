# Corporation Mechanics

## Overview

Corporations allow players to work together, share resources, and operate corporation-owned ships.

## Creating a Corporation

Use `create_corporation(name="...")` to create a new corporation.
- Requires sufficient ship credits for the founding fee
- Name must be 3-50 characters

## Joining a Corporation

Use `join_corporation(invite_code="...", corp_id="..." or corp_name="...")`
- Requires an invite code provided by the corporation
- Can specify corp_id (UUID) or corp_name (case-insensitive)

## Leaving a Corporation

Use `leave_corporation()` to leave your current corporation.

## Corporation Info

Use `corporation_info()` to get your corporation's information:
- Members list with names
- Ships with IDs, types, locations, status
- Corp ID and name

To list all corporations: `corporation_info(list_all=true)`
To look up a specific corp: `corporation_info(corp_id="...")`

## Corporation Ships

Corporation ships can be tasked and controlled by any member.

### Tasking a Corporation Ship

**CRITICAL: Two-step process required:**

1. Call `corporation_info()` to get ship_ids
2. Call `start_task(task_description="...", ship_id="<UUID>")`

Example flow:
```
1. corporation_info()
   → Returns ships: [{name: "Prober", ship_id: "023e9574-..."}, ...]

2. start_task(
     task_description="Explore until ten new sectors found",
     ship_id="023e9574-2527-444b-9875-46a1c591f17c"
   )
```

### Ship ID Formats
- Full UUID: "023e9574-2527-444b-9875-46a1c591f17c"
- Short ID: First 6-8 characters, shown in brackets like [023e95]
- When specifying ship_id, either format works

### Corporation Ship Types

Special autonomous ships can only be purchased for corporations:
- `autonomous_probe` - 1,000 credits, basic exploration
- `autonomous_light_hauler` - 5,000 credits, small cargo capacity

## Purchasing Corporation Ships

Use `purchase_ship` with `purchase_type="corporation"`:

```
purchase_ship(
    ship_type="autonomous_probe",
    purchase_type="corporation",
    ship_name="Scout Alpha",
    initial_ship_credits=500  # Optional: seed credits
)
```

- Draws from corporation bank credits
- Can optionally seed initial ship credits

## Kicking Members

Use `kick_corporation_member(target_id="...")` to remove a member.
- Requires the target's character_id

## Bank Operations with Corporation Ships

Corporation ships can deposit credits to member bank accounts:

```
bank_deposit(
    amount=5000,
    ship_id="<corp-ship-id>",
    target_player_name="Member Name"
)
```

The ship must be at a mega-port in Federation Space.
`target_player_name` must be a real member character name, not `Corp Ship [xxxxxx]`.

## Credit Transfers

Transfer credits between ships in the same sector:

```
transfer_credits(
    amount=1000,
    to_ship_id="<ship-id>" or to_ship_name="Ship Name"
)
```

## Tips

- Don't explain technical details (ship IDs, UUIDs) to the pilot
- Just execute the requested action and confirm
- When tasking multiple corp ships, you can run tasks concurrently
- Use short IDs from brackets for convenience
