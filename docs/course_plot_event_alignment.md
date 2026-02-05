# Course.Plot Event Alignment (course.plot)

This document lists where `course.plot` is emitted and what must change on the server to match `docs/event_catalog.md`.

**Where course.plot Events Are Emitted**

- `deployment/supabase/functions/plot_course/index.ts`

**Payload Builders / Helpers**

- `deployment/supabase/functions/_shared/map.ts` (`findShortestPath`)
- `deployment/supabase/functions/_shared/map.ts` (`fetchSectorRow`)

**Payload Mismatches vs `docs/event_catalog.md`**

1. Missing top-level `scope: "player" | "corporation"` in the event payload.

**Recommended Server Changes (To Match Catalog Shapes)**

1. Add `scope` to the `course.plot` payload in `plot_course/index.ts`.
   - Derive it from the *target* ship/character (same rule as status):
     - `scope = "corporation"` if the target ship is corp-owned (`ship.owner_type === "corporation"`) or the target character is a corp ship (`player_type === "corporation_ship"`).
     - Otherwise `scope = "player"`.
   - Use the shared helpers in `_shared/status.ts` (`resolvePlayerType`, `resolveScope`) for consistency.

**Notes**

- `source` metadata is already included in the payload via `buildEventSource` and `emitCharacterEvent`. It is allowed by `ServerMessagePayload` even if not explicitly listed in the catalog.
