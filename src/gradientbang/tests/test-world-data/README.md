# Test Universe Data

This is a minimal, deterministic universe for integration testing.

## Universe Structure (10 sectors)

```
    0 ←→ 1 ←→ 3 ←→ 7 ←→ 9
    ↓     ↘   ↑     ↘ ↗
    ↓      4 ←┘      8
    ↓                ↑
    2 ←→ 6 ←→ 5 ─────┘
```

### Sector Connections:
- **Sector 0**: ↔ 1, ↔ 2, → 5 (one-way to 5)
- **Sector 1**: ↔ 0, ↔ 3, → 4 (one-way to 4)
- **Sector 2**: ↔ 0, → 3 (one-way to 3), ↔ 6
- **Sector 3**: ↔ 1, ↔ 4, ↔ 7
- **Sector 4**: ↔ 3, ↔ 8
- **Sector 5**: ↔ 6, → 9 (one-way to 9)
- **Sector 6**: ↔ 2, ↔ 5, → 7 (one-way to 7)
- **Sector 7**: ↔ 3, → 8 (one-way to 8), ↔ 9
- **Sector 8**: ↔ 4, ↔ 9
- **Sector 9**: ↔ 7, ↔ 8

### Sector Contents:
- **Ports**: Sectors 1 (BBS), 3 (BSS), 5 (BSB), 9 (BBB)
  - Each port has inventory: stock/stock_max for sells, demand/demand_max for buys
  - Starting at 70% capacity (700/1000 units)
- **Planets**: None (disabled for MVP)

## Test Properties

1. **Deterministic**: Always the same structure (seed: 12345)
2. **Small**: Only 10 sectors for fast testing
3. **Complete**: All sectors are reachable from sector 0
4. **Mixed connections**: Both one-way and two-way warps
5. **Varied content**: Mix of ports, planets, and empty sectors

## Why This Design?

- **Predictable paths**: We know exact distances between sectors
- **Edge cases**: One-way warps test directional movement
- **Port variety**: Different port classes for trading tests
- **Isolated from production**: Changes to main universe don't break tests
