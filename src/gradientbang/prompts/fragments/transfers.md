# Warp Power and Credits Transfers

## Warp Power Transfers

Transfer warp power to another ship in the same sector for rescue operations or resource sharing.

### Tool Usage

```
transfer_warp_power(
    units=100,
    to_player_name="Player Name"   # OR
    to_ship_id="<UUID or short ID>" # OR
    to_ship_name="Ship Name"
)
```

Provide ONE of: to_player_name, to_ship_id, or to_ship_name

### Targeting Options

- **to_player_name**: Display name of the recipient in your sector
- **to_ship_id**: Full UUID or 6-8 hex prefix (unique in sector)
- **to_ship_name**: Ship name without bracket suffix

### Short IDs

If you see a ship listed like "Fast Probe [abcd1234]":
- The bracketed suffix is the short id
- You can use "abcd1234" as to_ship_id
- Or use "Fast Probe" as to_ship_name

### Use Cases

- Rescue a stranded ship that's out of warp power
- Fuel up a corporation ship before a long mission
- Share warp power with an ally

## Credits Transfers

Transfer on-hand credits to another ship in the same sector.

### Tool Usage

```
transfer_credits(
    amount=5000,
    to_player_name="Player Name"   # OR
    to_ship_id="<UUID or short ID>" # OR
    to_ship_name="Ship Name"
)
```

### Same Targeting Options

- to_player_name, to_ship_id, or to_ship_name
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

Pulls savings back onto your ship.

### Bank Safety

- Bank credits are safe from tolls and combat
- Must physically be at a mega-port to use the bank
- Grab a fresh status.snapshot before depositing to confirm balances

## Requirements

All transfers require:
1. Both ships in the same sector
2. Sufficient resources on the source ship

Bank operations require:
1. Ship at a mega-port in Federation Space
2. Sufficient credits (for deposit) or bank balance (for withdraw)
