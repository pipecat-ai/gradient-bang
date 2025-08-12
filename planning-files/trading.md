# Trading System Design

## Overview

The trading system enables players to buy and sell commodities at ports throughout the universe. This creates an economic gameplay loop where players can profit from trade routes, manage cargo capacity, and respond to dynamic market conditions.

## Core Mechanics

### Commodities
Three tradeable commodities exist in the game:
- **fuel_ore**: Base price 25 credits
- **organics**: Base price 10 credits  
- **equipment**: Base price 40 credits

### Port Classes
Ports are classified 1-8, determining what they buy (B) and sell (S):
1. BBS - Buys fuel_ore, Buys organics, Sells equipment
2. BSB - Buys fuel_ore, Sells organics, Buys equipment
3. SBB - Sells fuel_ore, Buys organics, Buys equipment
4. SSB - Sells fuel_ore, Sells organics, Buys equipment
5. SBS - Sells fuel_ore, Buys organics, Sells equipment
6. BSS - Buys fuel_ore, Sells organics, Sells equipment
7. SSS - Sells all three commodities
8. BBB - Buys all three commodities

Complementary ports (like class 1 and 7) create natural trade routes.

### Dynamic Pricing

Prices fluctuate based on supply and demand using exponential curves for realistic market behavior:

**When ports SELL to players:**
- High stock → Low prices (75% of base at full capacity)
- Low stock → High prices (110% of base when nearly empty)
- Uses sqrt curve: prices rise slowly at first, then spike near depletion

**When ports BUY from players:**
- High demand → High prices (130% of base when desperate)
- Low demand → Low prices (90% of base when saturated)
- Uses sqrt curve: prices drop slowly at first, then plunge near saturation

### Cargo Management

Ships have limited cargo holds that constrain trading:
- Cargo capacity is shared across all three commodities
- Total commodities carried cannot exceed ship's cargo_holds value
- Fighters and shields are stored separately and don't consume cargo space

### Transaction Rules

All trades are atomic - they either complete fully or fail entirely:
- Players must have sufficient credits to buy
- Players must have sufficient cargo space for purchases
- Players must have the commodities they're trying to sell
- Ports must have stock to sell or capacity to buy

## Persistence & State Management

### Character Credits
- Stored in character knowledge files
- Updated after every transaction
- Can be overridden via /api/join for testing

### Port States
- Stored separately from universe data in `world-data/port-states/`
- One file per port, named by sector (e.g., `sector_123.json`)
- Includes current stock/demand levels and last update timestamp
- Initialized from universe data on first access

### Trade History
- Append-only JSONL file for audit trail
- Records: timestamp, player, sector, commodity, quantity, price, credits
- Useful for debugging, analytics, and detecting exploits

## API Endpoints

### Trading Operations
- `POST /api/trade` - Execute buy/sell transactions
- `GET /api/check_trade` - Preview prices without committing
- `GET /api/status` - Shows current prices if at a port

### Port Management
- `POST /api/reset_ports` - Reset all ports to initial state
- `POST /api/regenerate_ports` - Partial regeneration simulating daily trade

## NPC Integration

NPCs need sophisticated trading capabilities:
- Track commodity prices in their map knowledge
- Find profitable trade routes between known ports
- Execute trades using natural language commands
- Consider cargo capacity and credit constraints

## Implementation Plan

### Stage 1: Foundation (Credits & Pricing)
- Add credits field to character knowledge with persistence
- Update /api/join to accept optional credits parameter
- Create pricing constants and calculation functions with sqrt curves

### Stage 2: Read-Only Market Data
- Create port state management system with timestamps
- Display current prices in /api/status when at a port
- Implement /api/check_trade preview endpoint

### Stage 3: Buying Functionality
- Implement buying from ports via /api/trade
- Add cargo capacity validation
- Ensure transaction atomicity

### Stage 4: Selling Functionality  
- Implement selling to ports via /api/trade
- Add trade history logging in JSONL format
- Broadcast trade events through firehose

### Stage 5: Port Management
- Create /api/reset_ports endpoint for full reset
- Create /api/regenerate_ports for partial daily regeneration
- Add regeneration tracking to port states

### Stage 6: Client Integration
- Update AsyncGameClient to support all trading operations
- Add find_profitable_route tool for NPC route planning
- Add trade tool for NPC natural language trading

### Stage 7: Testing & Polish
- Write comprehensive tests for all trading features
- Test edge cases and error conditions
- Verify NPC trading behavior

## Design Rationale

### Why Dynamic Pricing?
Static prices would make trading trivial and boring. Dynamic pricing based on supply/demand creates interesting decisions about when and where to trade.

### Why Exponential Curves?
Linear pricing is unrealistic. Real markets show little price movement in normal conditions but dramatic swings at extremes. The sqrt curve models this naturally.

### Why Atomic Transactions?
Partial trades would complicate the game logic and could lead to exploits. All-or-nothing trades are simpler to understand and implement.

### Why Separate Port State Files?
Keeping port states separate from universe structure allows for easy resets, avoids corrupting the base universe, and enables efficient updates to individual ports.

### Why JSONL for History?
JSONL allows append-only writes without parsing the entire file, making it efficient for high-frequency logging while remaining human-readable.