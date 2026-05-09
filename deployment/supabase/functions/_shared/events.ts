import type { SupabaseClient } from "@supabase/supabase-js";

import {
  computeSectorVisibilityRecipients,
  dedupeRecipientSnapshots,
  type EventRecipientSnapshot,
} from "./visibility.ts";
import { injectCharacterEventIdentity } from "./event_identity.ts";
import type { RequestLogger } from "./logger.ts";

type EventScope =
  | "direct"
  | "sector"
  | "corp"
  | "broadcast"
  | "gm_broadcast"
  | "self"
  | "system"
  | "admin";

export interface EventSource {
  type: string;
  method: string;
  request_id: string;
  timestamp: string;
}

export interface RecordEventWithRecipientsOptions {
  supabase: SupabaseClient;
  eventType: string;
  scope: EventScope;
  direction?: "rpc_in" | "event_out";
  payload: Record<string, unknown>;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  sectorId?: number | null;
  shipId?: string | null;
  characterId?: string | null;
  senderId?: string | null;
  actorCharacterId?: string | null;
  corpId?: string | null;
  taskId?: string | null;
  recipients?: EventRecipientSnapshot[];
  broadcast?: boolean;
}

export async function recordEventWithRecipients(
  options: RecordEventWithRecipientsOptions,
): Promise<void> {
  const {
    supabase,
    eventType,
    scope,
    direction = "event_out",
    payload,
    requestId,
    meta,
    sectorId,
    shipId,
    characterId,
    senderId,
    actorCharacterId,
    corpId,
    taskId,
    recipients = [],
    broadcast = false,
  } = options;

  const normalizedRecipients = dedupeRecipientSnapshots(recipients);
  if (!normalizedRecipients.length && !broadcast && !corpId) {
    return;
  }

  const recipientIds = normalizedRecipients.map(
    (recipient) => recipient.characterId,
  );
  const recipientReasons = normalizedRecipients.map(
    (recipient) => recipient.reason,
  );

  const { error } = await supabase.rpc("record_event_with_recipients", {
    p_event_type: eventType,
    p_direction: direction,
    p_scope: scope,
    p_actor_character_id: actorCharacterId ?? null,
    p_corp_id: corpId ?? null,
    p_sector_id: sectorId ?? null,
    p_ship_id: shipId ?? null,
    p_character_id: characterId ?? null,
    p_sender_id: senderId ?? null,
    p_payload: payload ?? {},
    p_meta: meta ?? null,
    p_request_id: requestId ?? null,
    p_recipients: recipientIds,
    p_reasons: recipientReasons,
    p_is_broadcast: broadcast,
    p_task_id: taskId ?? null,
  });

  if (error) {
    console.error("events.recordEventWithRecipients.rpc", {
      eventType,
      scope,
      error,
    });
    throw new Error(`failed to record event ${eventType}: ${error.message}`);
  }

  // Dual-write to pgmq. The events row above is authoritative — polling reads
  // from `events_since` which queries the events table directly, so a pgmq
  // failure here cannot affect polling subscribers. Failures inside the helper
  // are logged at error level; we never raise out of this block.
  await publishEventToPgmq({
    supabase,
    eventType,
    scope,
    direction,
    payload,
    requestId,
    meta,
    sectorId,
    shipId,
    characterId,
    senderId,
    actorCharacterId,
    corpId,
    taskId,
    recipients: normalizedRecipients,
    broadcast,
  });
}

/**
 * Fan out an event to per-character pgmq queues.
 *
 * Mirrors the recipient expansion done by `record_event_with_recipients`:
 * direct recipient ids plus, when corp_id is set, the full corp delivery set
 * (active members + corp-owned ship pseudo-characters). De-duplicated so
 * each character receives exactly one message per event.
 *
 * Each recipient gets a message body shaped like a single ``events_since``
 * row — top-level ``event_context`` with that recipient's id/reason, plus
 * ``__task_id`` injected into the payload — so ``PubsubEventAdapter``'s
 * dispatch path can lift it into ``__event_context`` exactly the way the
 * polling adapter does. Without this, ``EventRelay`` drops non-combat events
 * (event_context missing) and loses task-scoped routing.
 *
 * Failures are logged at error level but never raised — the events table is
 * authoritative (polling reads from it) and one bad recipient must not block
 * the rest. Errors here mean pubsub subscribers won't receive the event;
 * watch the logs.
 */
async function publishEventToPgmq(opts: {
  supabase: SupabaseClient;
  eventType: string;
  scope: EventScope;
  direction: "rpc_in" | "event_out";
  payload?: Record<string, unknown>;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  sectorId?: number | null;
  shipId?: string | null;
  characterId?: string | null;
  senderId?: string | null;
  actorCharacterId?: string | null;
  corpId?: string | null;
  taskId?: string | null;
  recipients: EventRecipientSnapshot[];
  broadcast: boolean;
}): Promise<void> {
  // Direct recipients win over corp-expanded ones (preserve their reason).
  const reasonByRecipient = new Map<string, string>();
  for (const r of opts.recipients) {
    if (!reasonByRecipient.has(r.characterId)) {
      reasonByRecipient.set(r.characterId, r.reason);
    }
  }
  if (opts.corpId) {
    try {
      const corpReasonMap = await loadCorpDeliveryReasons(
        opts.supabase,
        opts.corpId,
      );
      // Skip corp_ship pseudo-character queues when any corp_member is also a
      // recipient: the human members already get the event on their own
      // chr_{character_id} queue, and a bot's set_scope(ship_ids=[…]) extra
      // subscription on chr_{ship_id} would otherwise compete-consume with
      // peer corp members' bots and double-dispatch for whichever bot wins
      // the read race. We drop corp_ship ids from BOTH the corp expansion and
      // any direct recipients (e.g. when the event subject IS the corp ship
      // pseudo-character, as with corp-ship movement), since the auth model
      // requires corp membership to access a corp ship in the first place —
      // every legitimate consumer of chr_{ship_id} is also receiving via
      // chr_{member_id}. Mirrors the SQL exclusion in migration 20260414000000
      // for the polling/events-table path.
      const hasCorpMembers = Array.from(corpReasonMap.values()).some(
        (r) => r === "corp_member",
      );
      if (hasCorpMembers) {
        for (const [id, reason] of corpReasonMap) {
          if (reason === "corp_ship") reasonByRecipient.delete(id);
        }
      }
      for (const [id, reason] of corpReasonMap) {
        if (hasCorpMembers && reason === "corp_ship") continue;
        if (!reasonByRecipient.has(id)) {
          reasonByRecipient.set(id, reason);
        }
      }
    } catch (err) {
      console.error("events.publishEventToPgmq.corp_expand_failed", {
        eventType: opts.eventType,
        corpId: opts.corpId,
        err,
      });
      // Continue with whatever we have — direct recipients still get the message.
    }
  }

  // Mirror events_since/normalizeEventRow: __task_id lives inside the payload.
  const basePayload = opts.payload ?? {};
  const payloadOut =
    typeof opts.taskId === "string" && opts.taskId.length > 0
      ? { ...basePayload, __task_id: opts.taskId }
      : basePayload;

  // Broadcast events fan out to every active subscriber via Postgres
  // LISTEN/NOTIFY (see migration 20260505000000_pubsub_and_broadcasts.sql).
  // pgmq is the wrong primitive here — read+archive is competing-consumer,
  // the first reader to archive consumes the message for everyone else.
  // notify_broadcast() is service_role-only, so subscribers cannot publish.
  if (opts.broadcast) {
    const broadcastMsg = {
      event_type: opts.eventType,
      direction: opts.direction,
      scope: opts.scope,
      payload: payloadOut,
      meta: opts.meta ?? null,
      request_id: opts.requestId ?? null,
      sector_id: opts.sectorId ?? null,
      ship_id: opts.shipId ?? null,
      character_id: opts.characterId ?? null,
      sender_id: opts.senderId ?? null,
      actor_character_id: opts.actorCharacterId ?? null,
      corp_id: opts.corpId ?? null,
      task_id: opts.taskId ?? null,
      is_broadcast: true,
      recipient_id: null as string | null,
      recipient_reason: null as string | null,
      recipient_ids: [] as string[],
      recipient_reasons: [] as string[],
      event_context: {
        event_id: null as number | null,
        character_id: null as string | null,
        reason: null as string | null,
        scope: opts.scope,
        recipient_ids: [] as string[],
        recipient_reasons: [] as string[],
      },
    };
    const { error: broadcastErr } = await opts.supabase.rpc(
      "notify_broadcast",
      { p_payload: broadcastMsg },
    );
    if (broadcastErr) {
      console.error("events.publishEventToPgmq.broadcast_send_failed", {
        eventType: opts.eventType,
        error: broadcastErr,
      });
    }
  }

  if (reasonByRecipient.size === 0) return;

  for (const [recipient, reason] of reasonByRecipient) {
    const queueName = `chr_${recipient}`;
    const msg = {
      event_type: opts.eventType,
      direction: opts.direction,
      scope: opts.scope,
      payload: payloadOut,
      meta: opts.meta ?? null,
      request_id: opts.requestId ?? null,
      sector_id: opts.sectorId ?? null,
      ship_id: opts.shipId ?? null,
      character_id: opts.characterId ?? null,
      sender_id: opts.senderId ?? null,
      actor_character_id: opts.actorCharacterId ?? null,
      corp_id: opts.corpId ?? null,
      task_id: opts.taskId ?? null,
      is_broadcast: opts.broadcast,
      recipient_id: recipient,
      recipient_reason: reason,
      recipient_ids: [recipient],
      recipient_reasons: [reason],
      // event_id is null because record_event_with_recipients doesn't return
      // the inserted id. Pubsub dedupes via pgmq msg_id; polling.py's
      // _record_event_id treats non-int as "always allow", so this is safe.
      event_context: {
        event_id: null as number | null,
        character_id: recipient,
        reason,
        scope: opts.scope,
        recipient_ids: [recipient],
        recipient_reasons: [reason],
      },
    };
    const { error } = await opts.supabase.rpc("pgmq_publish", {
      p_queue_name: queueName,
      p_msg: msg,
    });
    if (error) {
      console.error("events.publishEventToPgmq.send_failed", {
        eventType: opts.eventType,
        queueName,
        error,
      });
    }
  }
}

/**
 * Load a corporation's "delivery membership set" — the set of character_ids
 * that the SQL `record_event_with_recipients` function treats as receiving
 * via the corp row instead of an individual row. Mirrors the v_corp_member_ids
 * union (active corp members + corp-owned ship pseudo-chars) from migration
 * 20260414000000.
 */
async function loadCorpDeliverySet(
  supabase: SupabaseClient,
  corpId: string,
): Promise<Set<string>> {
  return new Set((await loadCorpDeliveryReasons(supabase, corpId)).keys());
}

/**
 * Same union as :func:`loadCorpDeliverySet` but tagged with the per-recipient
 * delivery reason so pubsub messages can carry an accurate ``recipient_reason``
 * (``corp_member`` for active members, ``corp_ship`` for corp-owned ship
 * pseudo-chars). Direct corp_member rows take precedence over corp_ship for
 * any id that appears in both sets.
 */
async function loadCorpDeliveryReasons(
  supabase: SupabaseClient,
  corpId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const { data: ships, error: shipErr } = await supabase
    .from("ship_instances")
    .select("ship_id")
    .eq("owner_type", "corporation")
    .eq("owner_corporation_id", corpId);
  if (shipErr) {
    console.error("events.loadCorpDeliverySet.ships", { corpId, shipErr });
  }
  for (const row of ships ?? []) {
    if (typeof row?.ship_id === "string") map.set(row.ship_id, "corp_ship");
  }

  const { data: members, error: memberErr } = await supabase
    .from("corporation_members")
    .select("character_id")
    .eq("corp_id", corpId)
    .is("left_at", null);
  if (memberErr) {
    console.error("events.loadCorpDeliverySet.members", { corpId, memberErr });
  }
  for (const row of members ?? []) {
    if (typeof row?.character_id === "string") {
      map.set(row.character_id, "corp_member");
    }
  }

  return map;
}

export interface RecordBroadcastByCorpOptions {
  supabase: SupabaseClient;
  eventType: string;
  payload: Record<string, unknown>;
  scope?: EventScope;
  requestId: string;
  sectorId?: number | null;
  recipients: EventRecipientSnapshot[];
  stakeholderCorpIds: string[];
  actorCharacterId?: string | null;
  taskId?: string | null;
}

/**
 * Emit a multi-recipient event with deliveries partitioned by corp affiliation.
 *
 * For each stakeholder corp, recipients in that corp's delivery set are
 * bundled into a single emit with that `corpId` so the SQL merge logic
 * collapses individual + corp delivery into one corp row (one delivery per
 * member). Recipients outside every stakeholder corp fall into a residual
 * emit with `corpId=null` and receive individual rows.
 *
 * Why this exists: a single `recordEventWithRecipients` call accepts only
 * one `corpId`. In multi-corp scenarios (e.g. corp-vs-corp combat,
 * corp-ship-vs-enemy-garrison), passing one corp's id leaves the other
 * corp's members getting both an individual row AND a duplicate via their
 * own corp poll filter. Partitioning per-corp keeps the merge logic correct
 * for every recipient simultaneously.
 */
export async function recordBroadcastByCorp(
  options: RecordBroadcastByCorpOptions,
): Promise<void> {
  const {
    supabase,
    eventType,
    payload,
    scope = "sector",
    requestId,
    sectorId,
    recipients,
    stakeholderCorpIds,
    actorCharacterId = null,
    taskId = null,
  } = options;

  if (!recipients.length) return;

  const uniqueCorpIds = Array.from(
    new Set(
      stakeholderCorpIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  );
  const corpSets = new Map<string, Set<string>>();
  if (uniqueCorpIds.length) {
    const sets = await Promise.all(
      uniqueCorpIds.map((cid) => loadCorpDeliverySet(supabase, cid)),
    );
    uniqueCorpIds.forEach((cid, i) => corpSets.set(cid, sets[i]));
  }

  const buckets = new Map<string | null, EventRecipientSnapshot[]>();
  for (const recipient of recipients) {
    let assigned: string | null = null;
    for (const [cid, members] of corpSets) {
      if (members.has(recipient.characterId)) {
        assigned = cid;
        break;
      }
    }
    const arr = buckets.get(assigned) ?? [];
    arr.push(recipient);
    buckets.set(assigned, arr);
  }

  for (const [corpId, bucketRecipients] of buckets) {
    if (!bucketRecipients.length) continue;
    await recordEventWithRecipients({
      supabase,
      eventType,
      scope,
      payload,
      requestId,
      sectorId,
      corpId,
      actorCharacterId,
      recipients: bucketRecipients,
      taskId,
    });
  }
}

export function buildEventSource(
  method: string,
  requestId: string,
  sourceType = "rpc",
): EventSource {
  return {
    type: sourceType,
    method,
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };
}

interface CharacterEventOptions {
  supabase: SupabaseClient;
  characterId: string;
  eventType: string;
  payload: Record<string, unknown>;
  senderId?: string | null;
  sectorId?: number | null;
  shipId?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  corpId?: string | null;
  taskId?: string | null;
  recipientReason?: string;
  additionalRecipients?: EventRecipientSnapshot[];
  actorCharacterId?: string | null;
  scope?: EventScope;
  log?: RequestLogger | null;
}

export async function emitCharacterEvent(
  options: CharacterEventOptions,
): Promise<void> {
  const {
    supabase,
    characterId,
    eventType,
    payload,
    senderId,
    sectorId,
    shipId,
    requestId,
    meta,
    corpId,
    taskId,
    recipientReason,
    additionalRecipients = [],
    actorCharacterId,
    scope,
    log,
  } = options;

  const recipients = dedupeRecipientSnapshots([
    { characterId, reason: recipientReason ?? "direct" },
    ...additionalRecipients,
  ]);
  if (!recipients.length) {
    console.warn("emitCharacterEvent.no_recipients", {
      eventType,
      characterId,
    });
    return;
  }

  const finalPayload = injectCharacterEventIdentity({
    payload,
    characterId,
    shipId,
    eventType,
  });

  const emitMsg = `emit ${eventType} scope=${scope ?? "direct"} char=${characterId}`;
  if (log) {
    log.info(emitMsg);
  } else {
    console.log(`${emitMsg}${requestId ? ` req=${requestId}` : ""}`);
  }

  await recordEventWithRecipients({
    supabase,
    eventType,
    scope: scope ?? "direct",
    payload: finalPayload,
    requestId,
    meta,
    corpId,
    taskId,
    sectorId,
    shipId,
    characterId,
    senderId,
    actorCharacterId: actorCharacterId ?? senderId ?? characterId,
    recipients,
  });
}

interface SectorEventOptions {
  supabase: SupabaseClient;
  sectorId: number;
  eventType: string;
  payload: Record<string, unknown>;
  senderId?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  taskId?: string | null;
  recipients?: EventRecipientSnapshot[];
  actorCharacterId?: string | null;
  scope?: EventScope;
}

export async function emitSectorEvent(
  options: SectorEventOptions,
): Promise<void> {
  const {
    supabase,
    sectorId,
    eventType,
    payload,
    senderId,
    requestId,
    meta,
    taskId,
    recipients = [],
    actorCharacterId,
    scope = "sector",
  } = options;

  const normalizedRecipients = dedupeRecipientSnapshots(recipients);
  if (!normalizedRecipients.length) {
    return;
  }

  await recordEventWithRecipients({
    supabase,
    eventType,
    scope,
    payload,
    requestId,
    meta,
    taskId,
    sectorId,
    senderId,
    actorCharacterId: actorCharacterId ?? null,
    recipients: normalizedRecipients,
  });
}

interface SectorEnvelopeOptions extends SectorEventOptions {
  excludeCharacterIds?: string[];
}

export async function emitSectorEnvelope(
  options: SectorEnvelopeOptions,
): Promise<void> {
  const { supabase, sectorId, excludeCharacterIds = [] } = options;
  const recipients = await computeSectorVisibilityRecipients(
    supabase,
    sectorId,
    excludeCharacterIds,
  );
  await emitSectorEvent({ ...options, recipients });
}

export async function emitErrorEvent(
  supabase: SupabaseClient,
  params: {
    characterId: string;
    method: string;
    requestId: string;
    detail: string;
    status?: number;
    log?: RequestLogger | null;
  },
): Promise<void> {
  const payload = {
    source: buildEventSource(params.method, params.requestId),
    endpoint: params.method,
    error: params.detail,
    status: params.status ?? 400,
  } as Record<string, unknown>;
  await emitCharacterEvent({
    supabase,
    characterId: params.characterId,
    eventType: "error",
    payload,
    requestId: params.requestId,
    recipientReason: "error",
    log: params.log,
  });
}
