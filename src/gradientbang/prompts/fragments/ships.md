# Ship Purchasing and Types

## Ship Types

**You do NOT know ship prices.** Prices change and you must NEVER quote a price from memory. Always call `ship_definitions()` first to get current prices from the database. This returns all ship data including purchase prices, cargo capacity, warp power, shields, and fighters.

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
- Draws from corporation bank credits
- Can seed initial ship credits for the new ship
- Autonomous ships can ONLY be purchased for corporations

## Selling Corporation Ships

`sell_ship` has a built-in confirmation gate. It is a two-step process:

1. Call `sell_ship(ship_id="...")` — this returns a reminder instead of executing
2. **Speak** to the player (do NOT use send_message or any chat tool). Say the ship name, type, and trade-in value. Warn that cargo/credits on the ship will be lost.
3. After the player explicitly confirms, call `sell_ship(ship_id="...", confirmed=true)` to execute

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

1. **ALWAYS** call `ship_definitions()` first — never guess or assume prices
2. Check your credits (personal or corp bank)
3. Verify you can afford the ship (minus trade-in value if applicable)
4. Call `purchase_ship` with `expected_price` set to the exact base price from `ship_definitions()`
5. Receive status.update event confirming purchase

**NEVER tell the pilot a ship's price without calling `ship_definitions()` first. The server rejects purchases with incorrect prices.**

**IMPORTANT:** Personal ship purchases never require creating, joining, or leaving a corporation. If a purchase fails, report the error — do not modify corporation membership.

## Finding Ship Dealers

Ship purchases require your active ship to be docked at a mega-port. New ships appear at your current sector.
