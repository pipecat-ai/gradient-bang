# Combat RTVI and Database Event Flow

This table maps combat-related backend event writes to the RTVI events delivered
to clients. The relay forwards every visible database event to RTVI before its
LLM append/inference filters run, so "client receives" means the user's Pipecat
client receives an RTVI `frame_type=event` frame. The React app may still ignore
the payload if it is not relevant to the active player/session.

## Notification Classes

Combat events the viewer can see fall into two classes:

- **Direct combat** — the viewer's own character is in `participants[]`. This is
  the only class that counts as the viewer being "in active combat". It enters
  the React combat UI, cancels active player tasks, and (when round-1
  `combat.round_waiting` fires) takes the high-priority `combat_event` path in
  `InferenceGate` so the bot can interrupt itself to speak.
- **Observed combat** — the viewer is notified through one of: a corp ship that
  is a participant, an owned garrison, a corp-mate's garrison, or sector
  visibility. Observed combat is informational only: it does not enter the React
  combat UI, does not cancel tasks, and is treated as normal-priority `event`
  in `InferenceGate` so it speaks when appropriate but never bypasses the
  cooldown/interrupt rules.

Each combat encounter event (`combat.round_waiting`, `combat.round_resolved`,
`combat.ended`) carries a `combat_pov` XML attribute with one of:
`direct`, `observed_via_corp_ship`, `observed_via_garrison`,
`observed_sector_only`. Downstream gating reads this attr instead of inferring
from the event name.

## Notification Layers

A single combat event may surface (or not) through four independent layers.
The decisions are made in order; a viewer can be silent in one layer while
loud in another.

| Layer | Decision | Where |
| --- | --- | --- |
| DB / RTVI delivery | Visibility computed by `computeEventRecipients` (direct, sector_snapshot, garrison_owner, garrison_corp_member, corp_member). Every recipient gets the row and the RTVI frame. | `deployment/supabase/functions/_shared/event_recipients.ts` |
| React combat UI entry | Only when the active player is in `participants[]` (direct combat). Observers receive frames but `GameContext` ignores combat state for them. | `client/app/src/GameContext.tsx` |
| Voice spoken notification | LLM append + `run_llm` decision per `combat_pov`. Round-1 fires inference for direct + observed corp ship + observed garrison; sector-only is silent context. Rounds 2+ are participant-only. | `_should_run_llm` in `event_relay.py` |
| Interrupt / high-priority behavior | `InferenceGate` only routes a combat event through the `combat_event` priority lane (which bypasses bot-speaking cooldown) when `combat_pov="direct"`. Observed combat uses normal `event` priority. | `inference_gate.py` |

| Scenario | Database event written | Database recipients / scope | RTVI client receives | React client behavior |
| --- | --- | --- | --- | --- |
| Combat starts via `combat_initiate` | `combat.round_waiting` | One sector-scoped event. Recipients are direct combat participants, current sector observers, and corp members of participant/garrison corps. Recipient reasons come from `computeEventRecipients`: `direct`, `sector_snapshot`, `garrison_owner`, `garrison_corp_member`, `corp_member`. | Every recipient gets `combat.round_waiting`. Participants and observers receive the same non-personalized payload. | Participants enter/update combat UI. Non-participants receive the RTVI frame, but `GameContext` ignores it when the current player is not in `participants[]`. Voice LLM appends round 1 for observers as silent context; rounds 2+ are participant-only in LLM context. |
| Combat starts by garrison auto-engage on movement | `combat.round_waiting` | Same as above. Auto-engage pre-populates toll registry for toll garrisons. | Same as above. | Same as above. |
| Combat starts by deploying an offensive/toll garrison into an occupied sector | `combat.round_waiting` | Same as above. | Same as above. | Same as above. |
| Player submits an action: `attack`, `brace`, `flee`, or `pay` | `combat.action_accepted` | Direct event to the acting character only. | Acting character gets `combat.action_accepted`. | App confirms/stores accepted action only if the payload belongs to the active player and active combat. It does not wake voice inference. |
| Action submission completes the round | `combat.action_accepted`, then resolution events below | The action accepted event is direct to actor; round resolution events use sector/corp visibility. | Actor gets action accepted; all resolution recipients get the following round events. | The accepted action arrives before `combat.round_resolved`. |
| Round resolves and combat continues | `combat.round_resolved`, then `combat.round_waiting` | Each event is sector-scoped. Recipients are direct remaining participants, current sector observers, and corp members of participant/garrison corps. | Recipients get `combat.round_resolved`, then `combat.round_waiting`. | Participants update combat state/results. Non-participant observers receive RTVI frames, but the app ignores combat state if the current player is not in `participants[]`. |
| Round resolves and combat ends normally | `combat.round_resolved`, `combat.ended`, then `sector.update` | `combat.round_resolved` is sector-scoped to participants/observers/corp members. `combat.ended` is personalized and written once per participant recipient via direct character events. `sector.update` is sector-scoped to current sector visibility recipients. | Resolution recipients get `combat.round_resolved`. Each participant gets their own `combat.ended`. Sector occupants/garrison observers get `sector.update`. | Participant clients show the final round and clear combat on `combat.ended`. Observers may see `round_resolved` and `sector.update`; they should not receive personalized `combat.ended` unless they were a participant recipient. |
| Toll payment satisfies all outstanding tolls | `combat.action_accepted`, `combat.round_resolved`, `combat.ended`, `sector.update` | Same as action + normal combat end. `combat.round_resolved` has `end/result/round_result = toll_satisfied`. | Same as normal combat end. | Paying participant sees action accepted, resolved result, then combat ended. |
| Toll payment does not satisfy all hostiles | `combat.action_accepted`, `combat.round_resolved`, `combat.round_waiting` | Same as action + continuing round. | Same as continuing round. | Paid payer remains in combat until all hostiles pay, flee, are defeated, or combat otherwise ends. |
| Successful flee while combat continues | `combat.round_resolved`, flee movement cascade, personalized `combat.ended`, then `combat.round_waiting` for remaining participants | `combat.round_resolved` is sector-scoped before the fleer is removed, and marks the fleer with `has_fled` / `fled_to_sector`. Flee movement events are direct/observer events from movement helpers. The fleer receives a direct personalized `combat.ended`. Next `combat.round_waiting` should target remaining combat recipients only. | Fleer receives `combat.round_resolved`, `movement.start`, origin `character.moved` observer event as applicable, `movement.complete`, `map.local`, destination `character.moved` observer event as applicable, and direct `combat.ended`. Remaining participants receive continuing combat events. | Fleer client should clear combat and update sector/map. Remaining participants continue combat. This path is sensitive to stale recipient lists; avoid sending the next waiting event to departed fleers. |
| Successful flee ends the combat | `combat.round_resolved`, flee movement cascade, personalized fleer `combat.ended`; non-fleers get terminal `combat.ended`; `sector.update` | Fleer gets direct movement/map events and direct `combat.ended` from flee handling. Other participant recipients get personalized `combat.ended` from terminal resolution. `sector.update` goes to sector visibility recipients. | Fleer and remaining participants each receive their personalized terminal event once. | Duplicate `combat.ended` for fleers is explicitly skipped in terminal resolution. |
| Ship defeated | `combat.round_resolved`, optional `salvage.created`, `ship.destroyed`, `combat.ended`, `sector.update` | `salvage.created` is sector-scoped to sector visibility recipients. `ship.destroyed` is sector-scoped to sector observers plus corp members for corp ships. `combat.ended` is personalized for participants. | Recipients get the relevant salvage/destruction events plus combat terminal events. | App tracks destroyed ships from `ship.destroyed`; sector contents are refreshed by `sector.update`. |
| Garrison defeated | `combat.round_resolved`, `garrison.destroyed`, `combat.ended`, `sector.update` | `garrison.destroyed` is sector-scoped to sector visibility recipients plus owner/corp recipients computed from garrison owner data. | Owner/corp/sector recipients get `garrison.destroyed`. Participants also get terminal combat events if combat ends. | App removes the garrison from map sector state and adds an activity log entry. |
| Combat times out via `combat_tick` | Same as round resolution path: `combat.round_resolved` and either `combat.round_waiting` or terminal events | Same recipient rules as normal resolution. Timeout actions are synthesized as `brace` for active characters lacking pending actions. | Same as normal round resolution. | Participants see timed-out actions in the round payload. |
| Combat strategy set/cleared during combat prep | `ships.strategy_set` or `ships.strategy_cleared` | Direct event to the setting/clearing character. | Setting client receives strategy lifecycle RTVI event. | App updates strategy store. Voice relay may use strategy data as combat preamble on the next direct round-1 `combat.round_waiting`. |

## Event Visibility Summary

| Recipient type | Receives DB event row? | Receives RTVI frame? | Enters React combat UI? | Voice LLM context behavior |
| --- | --- | --- | --- | --- |
| Direct participant | Yes, reason `direct` for sector combat events; direct event for personalized `combat.ended` / `combat.action_accepted`. | Yes. | Yes. | `combat.round_waiting` and `combat.round_resolved` append with `combat_pov="direct"` and trigger inference at `combat_event` priority (can interrupt bot speech). |
| Sector observer not in combat | Yes for sector-scoped combat events when visible through sector occupancy. | Yes. | No; app ignores combat events where active player is not in `participants[]`. | Round-1 `combat.round_waiting` appends with `combat_pov="observed_sector_only"` as silent context (`run_llm=False`); rounds 2+ are filtered. Never takes `combat_event` priority. |
| Corp member observing corp ship combat | Yes through `corp_member` when participant payload exposes corp id. | Yes. | No unless their own active player is a participant. | Round-1 waiting appends with `combat_pov="observed_via_corp_ship"` and triggers inference at normal `event` priority — bot speaks when appropriate but does not interrupt. Later rounds filtered unless direct. |
| Garrison owner / garrison corp member | Yes through garrison visibility and corp membership. | Yes. | Does not enter personal combat UI unless also a participant. | Round-1 waiting appends with `combat_pov="observed_via_garrison"` and triggers inference at normal `event` priority. `garrison.destroyed` can trigger voice inference for the direct owner. |
| Successful fleer | Yes for resolved round and direct flee cascade events. | Yes. | Clears combat on personalized `combat.ended`; updates movement/map from movement cascade. | Gets direct combat end context; should not receive subsequent waiting events after departure. |
