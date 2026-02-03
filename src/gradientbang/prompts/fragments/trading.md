# Trading Mechanics

## Port Type Codes (CRITICAL)

The 3-letter port code tells you what trades are valid at that port.
Each letter position corresponds to a commodity: 1=QF, 2=RO, 3=NS

Letter meanings from YOUR perspective as a trader:
- **B** = Port Buys → YOU CAN SELL (trade_type="sell")
- **S** = Port Sells → YOU CAN BUY (trade_type="buy")

### Port Code Examples
- **BBS** port: You can SELL QF (B), SELL RO (B), BUY NS (S)
- **SBB** port: You can BUY QF (S), SELL RO (B), SELL NS (B)
- **SSS** port: You can BUY QF (S), BUY RO (S), BUY NS (S)
- **BBB** port: You can SELL QF (B), SELL RO (B), SELL NS (B)

COMMON MISTAKE: Do NOT try to BUY a commodity where the port has 'B' - that means the port BUYS it from you, so you can only SELL.

## Trade Execution

Before calling trade(), you MUST check:
1. Port code - verify the trade direction is valid
2. Empty holds - if 0, do NOT attempt to buy
3. Your cargo - only sell what you have
4. Your credits - can you afford the purchase?
5. Port inventory - does the port have enough stock?

Always SELL first to free holds before buying.

## Opportunistic Trading ("trade on the way")

When a task includes "trade on the way" or "trade when possible", trade at every port during the task.

### Decision Process at Each Port

**For SELLING, check each commodity you have against the port code:**
```
Port code: B S B  (positions 1, 2, 3)
           ↓ ↓ ↓
           Q R N
           F O S

Your cargo: 10 QF, 20 RO, 0 NS

QF: You have 10. Port position 1 = B (buys). → CAN SELL
RO: You have 20. Port position 2 = S (sells). → CANNOT SELL
NS: You have 0. Nothing to sell.

Result: Only sell QF.
```

**For BUYING (only if empty holds > 0):**
```
Port position 1 = B → cannot buy QF
Port position 2 = S → CAN BUY RO
Port position 3 = B → cannot buy NS

Result: Can only buy RO.
```

### Key Rules
- S in a position means the port SELLS that commodity - you can only BUY it
- B in a position means the port BUYS that commodity - you can only SELL it
- If empty holds is 0, skip buying entirely

### Opportunistic Trading Example

Task: "Explore 5 new sectors and trade on the way"

Arrive in sector 865. Status shows:
```
Cargo: 0 QF | 10 RO | 20 NS. Empty holds: 0.
Port: BSB
```

Step 1 - Check what you can SELL:
- Port BSB = B(QF) S(RO) B(NS)
- QF: You have 0. Nothing to sell.
- RO: You have 10. Port position 2 = S. CANNOT sell.
- NS: You have 20. Port position 3 = B. CAN sell.
→ trade(trade_type="sell", commodity="neuro_symbolics", quantity=20)

Step 2 - Check if you can BUY:
- Empty holds is 0. STOP. Do not attempt any buy trades.

Then continue to the next sector.

### Key Points
- Always SELL before BUY (frees up holds and gets you credits)
- Only sell commodities where the port has B for that position
- Only buy commodities where the port has S for that position
- Don't skip trading - the task asked for it
- Keep track of profit if asked to report it at the end

## Finding Ports

Use `list_known_ports` with filters:
- `commodity="quantum_foam", trade_type="sell"` - find ports that buy QF from you
- `commodity="retro_organics", trade_type="buy"` - find ports that sell RO to you
- `port_type="BBB"` - find specific port type
- `mega=true` - find mega-ports for banking/recharge

## Profit Calculation

From trade.executed events:
1. Sum total_price from trade_type="sell" events = total revenue
2. Sum total_price from trade_type="buy" events = total cost
3. Profit = revenue - cost
