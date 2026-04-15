# Warp Power and Credits Transfers

## Warp Power Transfers

Transfer warp power to another ship in the same sector for rescue operations or resource sharing.

### Tool Usage

```
transfer_warp_power(
    units=100,
    to_ship_id="<UUID or short ID>" # OR
    to_ship_name="Ship Name"        # OR
    to_player_name="Player Name"
)
```

Provide ONE of: to_ship_id, to_ship_name, or to_player_name. Prefer `to_ship_id` — read the recipient's `ship.ship_id` from your latest sector snapshot.

```
# Prefer ship_id (from sector snapshot):
transfer_warp_power(units=100, to_ship_id="<uuid>")
```

### Targeting Options

- **to_ship_id**: Full UUID or 6-8 hex prefix (unique in sector)
- **to_ship_name**: Ship name without bracket suffix
- **to_player_name**: Display name of the recipient in your sector (fallback when no ship_id known)

### Short IDs

If you see a ship listed like "Fast Probe [abcd1234]":
- The bracketed suffix is the short id
- You can use "abcd1234" as to_ship_id
- Or use "Fast Probe" as to_ship_name

### Use Cases

- Rescue a stranded ship that's out of warp power
- Fuel up a corporation ship before a long mission
- Share warp power with an ally

### Partial Transfer Rule

If a warp transfer moves some units and then stops because the recipient is at full warp capacity, treat that as a successful partial transfer, not a failed task, unless the commander explicitly required the full amount.

Do NOT call:

```python
finished(status="failed", message="Only part of the warp could be transferred because the recipient hit capacity.")
```

If any warp moved, report the actual transferred amount and finish the task as completed.

Example:

```python
# Asked to transfer all available warp to the commander.
# 497 requested, 200 transferred, then the commander reaches 1500/1500 warp.
finished(message="Transferred 200 warp to the commander until their ship reached full capacity (1500/1500). The source ship still has 297 warp remaining.")
```

## Credits Transfers

Transfer on-hand credits to another ship in the same sector.

### Tool Usage

```
transfer_credits(
    amount=5000,
    to_ship_id="<UUID or short ID>" # OR
    to_ship_name="Ship Name"        # OR
    to_player_name="Player Name"
)
```

```
# Prefer ship_id (from sector snapshot):
transfer_credits(amount=5000, to_ship_id="<uuid>")
```

### Same Targeting Options

- to_ship_id, to_ship_name, or to_player_name (prefer ship_id)
- Short IDs work the same as warp transfers

### Use Cases

- Fund a corporation ship for purchases
- Pay an ally for services
- Transfer earnings from exploration ship

## Warp Power Recharging

Recharge warp power at a mega-port in Federation Space.

### Tool Usage

```
recharge_warp_power(units=1000)
```

- Costs 2 credits per unit
- Must be at a mega-port in Federation Space

### Finding Mega-Ports

```
list_known_ports(mega=true, max_hops=100)
```

Returns nearest known mega-ports for recharging.

## Banking

Deposits and withdrawals at mega-port banks in Federation Space.

### Depositing

```
bank_deposit(
    amount=5000,
    target_player_name="Your Name"  # Your own account
)
```

For corporation ships depositing to a member:
```
bank_deposit(
    amount=5000,
    ship_id="<corp-ship-id>",
    target_player_name="Member Name"
)
```

`target_player_name` must be a real player/member character name. Do not use corporation ship identities like `Corp Ship [abcd12]`.

### Withdrawing

```
bank_withdraw(amount=3000)
```

Pulls savings back onto your ship. Corporation ships cannot withdraw from bank accounts — only personal ships can.

### Bank Safety

- Bank credits are safe from tolls and combat
- Must physically be at a mega-port to use the bank
- Grab a fresh status.snapshot before depositing to confirm balances
- Bank balance and credits on hand are different pools
- Bank balance does NOT auto-spend for actions that require credits on hand
- If an action needs credits on hand, withdraw first

Example:
```
"Can I buy that with banked credits?"
→ If the purchase needs credits on hand, call bank_withdraw(...) first.
```

## Requirements

All transfers require:
1. Both ships in the same sector
2. Sufficient resources on the source ship

Bank operations require:
1. Ship at a mega-port in Federation Space
2. Sufficient credits (for deposit) or bank balance (for withdraw)
