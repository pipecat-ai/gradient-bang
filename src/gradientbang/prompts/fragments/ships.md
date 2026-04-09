# Ship Purchasing and Types

## Ship Types

**Always call `ship_definitions()` before quoting prices or purchasing.** Never quote prices from memory — they may change. Returns all ship data: prices, cargo, warp, shields, fighters.

Ship categories:
- **Starter/Light** — cheap, low capacity
- **Cargo** — high cargo holds for trading
- **Combat** — strong shields, fighters, weapons
- **Autonomous (Corporation Only)** — can only be purchased for corporations

## Personal Ship Purchase

Use `purchase_ship` for personal purchases:

```
purchase_ship(
    ship_type="wayfarer_freighter",
    expected_price=120000,  # From ship_definitions()
    ship_name="My Trader"  # Optional
)
```

### Trade-In

When purchasing a new personal ship:
- Your current ship is automatically traded in
- Trade-in value is applied to the purchase price
- Or specify a different ship: `trade_in_ship_id="..."`

## Corporation Ship Purchase

Use `purchase_ship` with `purchase_type="corporation"`:

```
purchase_ship(
    ship_type="autonomous_probe",
    expected_price=1000,  # From ship_definitions()
    purchase_type="corporation",
    ship_name="Scout Alpha",
    initial_ship_credits=500  # Optional
)
```

### Corporation Purchase Notes
- Uses your ship credits (same as personal purchases)
- Can seed initial ship credits for the new ship (total cost = price + initial credits)
- Autonomous ships can ONLY be purchased for corporations

## Selling Corporation Ships

`sell_ship` removes the ship and returns trade-in value as credits.

### Selling Rules
- You can ONLY sell corporation ships that YOU purchased — not other members' ships
- You CANNOT sell your personal ship
- Must be docked at a mega-port
- Trade-in value (hull + remaining fighters) is added to your personal ship credits
- Any cargo or credits remaining on the sold ship are lost

## Renaming Ships

Use `rename_ship` to change a ship's display name:

```
rename_ship(ship_name="New Name")  # Your active ship
rename_ship(ship_name="New Name", ship_id="<UUID>")  # Corp ship
```

### Finding Ship IDs

For corporation ships, call `corporation_info()` first to get ship_ids.
- ship_id accepts full UUID or 6-8 hex prefix

## Ship Properties

Each ship type has different:
- **Cargo capacity** - How many holds for commodities
- **Warp power capacity** - Maximum warp fuel
- **Turns per warp** - Warp efficiency (affects travel range and flee chance)
- **Fighter capacity** - Maximum fighters aboard
- **Shield strength** - Combat defense

## Purchasing Process

1. Call `ship_definitions()` first
2. Check the balance used by that purchase path
   - Personal purchase: ship credits, minus trade-in if applicable
   - Corporation purchase: ship credits (no trade-in)
3. Call `purchase_ship` with `expected_price` from `ship_definitions()` — server rejects incorrect prices

**IMPORTANT:** Personal ship purchases never require creating, joining, or leaving a corporation. If a purchase fails, report the error — do not modify corporation membership.

## Finding Ship Dealers

Ship purchases require your active ship to be docked at a mega-port. New ships appear at your current sector.
