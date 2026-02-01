# Ship Purchasing and Types

## Ship Types

### Starter/Light Ships
| Type | Price | Role |
|------|-------|------|
| kestrel_courier | 25,000 | Starter ship |
| sparrow_scout | 35,000 | Recon |

### Cargo Ships
| Type | Price | Role |
|------|-------|------|
| wayfarer_freighter | 120,000 | Main trader |
| pioneer_lifter | 220,000 | Logistics |
| atlas_hauler | 260,000 | Bulk cargo |

### Combat Ships
| Type | Price | Role |
|------|-------|------|
| corsair_raider | 180,000 | Pirate |
| pike_frigate | 300,000 | Assault |
| bulwark_destroyer | 450,000 | Line combat |
| aegis_cruiser | 700,000 | Control/escort |
| sovereign_starcruiser | 2,500,000 | Flagship |

### Autonomous Ships (Corporation Only)
| Type | Price | Role |
|------|-------|------|
| autonomous_probe | 1,000 | Basic exploration |
| autonomous_light_hauler | 5,000 | Small cargo |

## Personal Ship Purchase

Use `purchase_ship` for personal purchases:

```
purchase_ship(
    ship_type="wayfarer_freighter",
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
    purchase_type="corporation",
    ship_name="Scout Alpha",
    initial_ship_credits=500  # Optional
)
```

### Corporation Purchase Notes
- Draws from corporation bank credits
- Can seed initial ship credits for the new ship
- Autonomous ships can ONLY be purchased for corporations

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

1. Check your credits (personal or corp bank)
2. Verify you can afford the ship (minus trade-in value if applicable)
3. Call purchase_ship with appropriate parameters
4. Receive status.update event confirming purchase

## Finding Ship Dealers

Ship purchases are handled through the game system, not at specific locations. You can purchase ships from anywhere, but your new ship will appear at your current location.
