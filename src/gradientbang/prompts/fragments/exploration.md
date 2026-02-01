# Exploration Mechanics

## Map Knowledge

As you explore the universe, you automatically build up map knowledge:
- Every sector you visit is remembered
- Port information (what they buy/sell) is recorded when discovered
- Sector connections are mapped as you travel

Your map knowledge persists between sessions.

## Navigation Strategies

### Discovering New Sectors
- You can only see and interact with your current sector
- Each move reveals new information about the sector you move to
- Adjacent sectors visible from your current position may be unvisited

### Finding Unvisited Sectors
1. Use `local_map_region()` to see nearby visited and unvisited sectors
2. The response includes "nearest unvisited" sectors with hop counts
3. Move toward the nearest unvisited sector

### Efficient Exploration
- When exploring, prioritize unvisited sectors over backtracking
- Check map.local events after each move for updated unvisited info
- Plan routes that chain multiple unvisited sectors together

## Movement

### One Sector at a Time
- You can only move ONE sector at a time
- The sector must be ADJACENT (directly connected by a warp)
- Always check your current position before moving

### Plotting Courses
- Use `plot_course(to_sector=N)` to find the shortest path
- This returns the full path - do NOT call it again after each move
- Simply follow the path by calling move() for each sector in sequence

### Warp Power Management
- Each move costs warp power based on your ship's efficiency
- Monitor your warp power level as you explore
- When running low, head to a mega-port to recharge

## Exploration Task Example

Task: "Explore 5 new sectors"

1. Check current status and local map
2. Find nearest unvisited sectors from map.local
3. Move to the nearest unvisited sector
4. After movement.complete, check if this was a first_visit
5. Update count of new sectors discovered
6. Repeat until 5 new sectors found
7. Call finished with summary

## Map Query Tools

### local_map_region()
Returns known sectors around your current location:
- Visited sectors with full details (ports, adjacents, position)
- Nearby unvisited sectors seen in adjacency lists
- Parameters: center_sector, max_hops (default 3), max_sectors

### list_known_ports()
Find ports within travel range:
- Filter by port_type, commodity, trade_type
- Filter by mega (true for mega-ports only)
- Parameters: from_sector, max_hops, various filters

### plot_course(to_sector)
Calculate shortest path to destination:
- Returns the full path as a list of sectors
- Note: only plots from your current sector

## First Visit Detection

In movement.complete events, the payload includes:
- `first_visit: true` if this is a newly discovered sector
- `first_visit: false` if you've been here before

Use this to count exploration progress.

## Exploration + Trading

When asked to "trade on the way" during exploration:
1. After each move, check for a port
2. Execute trades based on port type (see trading fragment)
3. Then continue to the next sector
4. Track both exploration progress and trade profit
