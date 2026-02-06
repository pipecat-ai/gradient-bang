const SHIP_SPECIFIC_EVENT_TYPES = new Set([
  "movement.start",
  "movement.complete",
  "course.plot",
  "path.region",
  "trade.executed",
  "warp.purchase",
  "warp.transfer",
  "credits.transfer",
  "fighter.purchase",
  "salvage.created",
  "salvage.collected",
  "garrison.deployed",
  "garrison.collected",
  "garrison.mode_changed",
  "ship.renamed",
  "ship.destroyed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isShipSpecificEvent(eventType: string): boolean {
  if (eventType.startsWith("status.")) {
    return true;
  }
  if (eventType.startsWith("combat.")) {
    return true;
  }
  return SHIP_SPECIFIC_EVENT_TYPES.has(eventType);
}

function getPlayerId(payload: Record<string, unknown>): string | null {
  const player = payload["player"];
  if (!isRecord(player)) {
    return null;
  }
  const candidate = player["id"];
  return hasNonEmptyString(candidate) ? candidate : null;
}

function hasShipBlock(payload: Record<string, unknown>): boolean {
  return isRecord(payload["ship"]);
}

function hasShipId(payload: Record<string, unknown>): boolean {
  return hasNonEmptyString(payload["ship_id"]);
}

export function injectCharacterEventIdentity(params: {
  payload: Record<string, unknown>;
  characterId: string;
  shipId?: string | null;
  eventType: string;
}): Record<string, unknown> {
  const { payload, characterId, shipId, eventType } = params;
  const finalPayload: Record<string, unknown> = { ...payload };

  if (!isRecord(finalPayload["player"])) {
    finalPayload["player"] = { id: characterId };
  }

  const playerId = getPlayerId(finalPayload);
  if (!playerId) {
    console.warn("event_identity.missing_player_id", {
      eventType,
      characterId,
      shipId: shipId ?? null,
      payloadKeys: Object.keys(finalPayload),
    });
  }

  if (!hasShipBlock(finalPayload) && !hasShipId(finalPayload) && shipId) {
    finalPayload["ship_id"] = shipId;
  }

  if (
    isShipSpecificEvent(eventType) &&
    !hasShipBlock(finalPayload) &&
    !hasShipId(finalPayload)
  ) {
    console.warn("event_identity.missing_ship_id", {
      eventType,
      characterId,
      shipId: shipId ?? null,
      payloadKeys: Object.keys(finalPayload),
    });
  }

  return finalPayload;
}
