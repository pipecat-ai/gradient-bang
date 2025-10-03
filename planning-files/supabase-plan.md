# Supabase Integration Proposal for Gradient Bang

## 1. Current Architecture Overview
- **In-memory world**: `core/world.py` loads the universe graph, sector contents, and port manager. Character knowledge is stored on disk and hydrated per join.
- **WebSocket server**: `game-server/server.py` exposes `/ws`. Clients send RPC-style frames; handlers in `game-server/api/*` mutate the in-memory world and respond. Push events originate from the same logic.
- **Clients**:
  - React UI (`client/`) uses RTVI transports, consuming init/status/map frames and issuing RPC calls (`move`, `trade`, etc.).
  - Voice/TUI bots leverage the same WebSocket endpoints via Pipecat transports.
- **Persistence**: Character map knowledge files; trade history and chat messages stored as JSONL; no central datastore.

## 2. Supabase Goals
1. **Durability**: Persist universe metadata, character state, maps, and logs in Postgres.
2. **Realtime events**: Replace ad-hoc push loops with Supabase Realtime feeds.
3. **Stateless servers**: Allow multiple `server.py` instances to run against shared data.
4. **Incremental migration**: Maintain existing WebSocket contract so clients need no immediate changes.

## 3. Proposed Schema (Postgres)
| Table | Key Columns | Notes |
|-------|-------------|-------|
| `universes` | `id`, `name`, `sector_count` | Active universe descriptor. |
| `sectors` | `id (PK)`, `universe_id`, `adjacent_sectors int[]`, `has_port` | Derived from `universe_structure.json`. |
| `ports` | `sector_id`, `code`, `class`, `last_seen_prices jsonb`, `last_seen_stock jsonb` | Mirrors current port state. |
| `planets` | `id`, `sector_id`, `class_code`, `class_name` | Flattened sector planets. |
| `characters` | `id`, `display_name`, `sector`, `last_active`, `credits`, `ship_type`, `ship_state jsonb`, timestamps | Replaces in-memory characters + knowledge. |
| `character_map` | `character_id`, `sector_id`, `last_visited`, `port_snapshot jsonb`, `adjacent_sectors`, `planets jsonb` | Superset of knowledge files. |
| `transactions` | `id`, `character_id`, `sector_id`, `type`, `commodity`, `quantity`, `price_per_unit`, `total_price`, `credits_after`, `created_at` | Trade/warp logs. |
| `chat_messages` | `id`, `type`, `from_character`, `to_name`, `content`, `created_at`, `metadata jsonb` | Chat history. |
| `movement_events` | `id`, `character_id`, `from_sector`, `to_sector`, `timestamp`, `payload jsonb` | Optional auditing. |
| `tasks` | `id`, `character_id`, `status`, `started_at`, `completed_at`, `context jsonb` | Bot/task lifecycle. |
| `sessions` | `id`, `character_id`, `client_type`, `connected_at`, `disconnected_at`, `webrtc_meta jsonb` | RTVI session tracking. |

Indexes: characters by sector; chat by created_at; views for active ports.

## 4. Realtime Model
- Enable Supabase Realtime on `characters`, `character_map`, `transactions`, `chat_messages`, `tasks`.
- `server.py` subscribes to relevant change feeds and pushes normalized `gg-action` frames.
- Optional future: clients subscribe directly via Supabase JS.

## 5. RPC Handler Translation
| Handler | Supabase Workflow |
|---------|-------------------|
| `join` | UPSERT character row, initialize map entries if new. Return joined status/map via SQL or PostgREST. |
| `move` | Transaction: validate adjacency, decrement warp power, update character sector, insert movement event, upsert `character_map`. |
| `my_status` | SELECT from `characters` joined with sector data -> return JSON payload. |
| `my_map` | SELECT map entries for character. |
| `trade` | Transaction updating cargo, credits, port stock (if modeled), insert `transactions`. |
| `check_trade` | Query ports/maps for candidate trades; pathfinding can remain in app or become SQL function. |
| `recharge_warp_power` | Update warp power/credits, insert `transactions`. |
| `transfer_warp_power` | Atomic update of two characters and log a transfer event. |
| Chat (`send_message`) | Insert into `chat_messages`; rely on Realtime for fan-out. |
| Push events | Subscribe to table changes; broadcast `my_status`, `my_map`, etc., on diffs with rate limiting. |

Repository layer hides Supabase specifics so api handlers remain slim.

## 6. Client Considerations
- **React UI**: Continue using existing `/ws` contract. Optionally add Supabase JS later for direct subscription (chat, status).
- **Bots/TUI**: No changes needed; they stay on WebSocket RPC.
- **Admin tooling**: Migrate JSON scripts to insert into Supabase tables. Explorer queries can replace JSONL inspection.

## 7. Migration Plan
1. **Schema migration**: Create `supabase/schema.sql` and apply via Supabase migrations. Include RLS policies if needed.
2. **Data import**: Load universe/sectors/ports/planets from current JSON. Convert character knowledge & history files to tables.
3. **Repositories**: Implement Supabase-backed repositories (`characters_repo`, `map_repo`, etc.) with caching.
4. **Handler updates**: Swap API handlers to call repositories. Maintain adjacency in memory for quick validation.
5. **Realtime wiring**: Subscribe to Supabase change feeds and translate to existing WebSocket events.
6. **Testing**: Spin up Supabase locally (Docker). Update integration tests to run migrations and validate RPC workflows.
7. **Rollout**: Deploy Supabase, configure environment variables, deploy updated server. Run dual-mode (file + Supabase) during cutover if needed.

## 8. Benefits & Future Enhancements
- Durable state, richer analytics (SQL on transactions/chat).
- Horizontal scalability for the game server.
- Unified event stream powered by Supabase Realtime.
- Foundation for optional direct Supabase access from clients/bots.

Future iterations could push more logic (trade routing, telemetry) into Supabase edge functions or rely entirely on Supabase auth. EOF
