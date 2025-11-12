import { RESOURCE_SHORT_NAMES } from "../types/constants";
import {
  type CreditsTransferMessage,
  type WarpTransferMessage,
} from "../types/messages";

export function transferSummaryString(
  transfer: CreditsTransferMessage | WarpTransferMessage
) {
  const { transfer_direction, transfer_details, from, to } = transfer;
  const { name: from_name } = from;
  const { name: to_name } = to;

  const payload: [string, number][] = [];

  Object.entries(transfer_details).forEach(([key, value]) => {
    payload.push([key, value]);
  });

  const data = {
    direction_long: transfer_direction === "received" ? "received" : "sent",
    direction_short: transfer_direction === "received" ? "from" : "to",
    player_name: transfer_direction === "received" ? from_name : to_name,
    payload: payload,
  };

  return `${
    data.direction_long.charAt(0).toUpperCase() + data.direction_long.slice(1)
  } [${data.payload.map(([key, value]) => `${key}: ${value}`).join(", ")}] ${
    data.direction_short
  } [${data.player_name}]`;
}

export function salvageCollectedSummaryString(salvage: Salvage) {
  try {
    const parts: string[] = [];
    const collected = salvage.collected;

    // Add cargo items that were collected
    if (collected?.cargo) {
      for (const [resource, amount] of Object.entries(collected.cargo)) {
        if (amount > 0) {
          const shortName = RESOURCE_SHORT_NAMES[resource as Resource];
          parts.push(`[${shortName}: ${amount}]`);
        }
      }
    }

    // Add credits if present and non-zero
    if (collected?.credits && collected.credits > 0) {
      parts.push(`[Credits: ${collected.credits}]`);
    }

    return ` ${parts.join(" ")}`;
  } catch {
    return " ";
  }
}

export function salvageCreatedSummaryString(salvage: {
  cargo?: Record<string, number>;
  scrap?: number;
  credits?: number;
}) {
  try {
    const parts: string[] = [];

    if (salvage.cargo) {
      for (const [resource, amount] of Object.entries(salvage.cargo)) {
        if (typeof amount === "number" && amount > 0) {
          const shortName = RESOURCE_SHORT_NAMES[resource as Resource];
          parts.push(`[${shortName}: ${amount}]`);
        }
      }
    }

    if (salvage.scrap && salvage.scrap > 0) {
      parts.push(`[Scrap: ${salvage.scrap}]`);
    }

    if (salvage.credits && salvage.credits > 0) {
      parts.push(`[Credits: ${salvage.credits}]`);
    }

    return ` ${parts.join(" ")}`;
  } catch {
    return " ";
  }
}

function getMetaValue<T>(
  meta: Record<string, unknown> | undefined,
  key: string
) {
  if (!meta) {
    return undefined;
  }

  return meta[key] as T | undefined;
}

function normalizeSignaturePart(part: unknown) {
  if (part === undefined || part === null) {
    return "";
  }
  if (typeof part === "string") {
    return part.trim().toLowerCase();
  }
  if (typeof part === "number" || typeof part === "boolean") {
    return String(part);
  }
  if (part instanceof Date) {
    return part.toISOString();
  }
  if (typeof part === "object") {
    try {
      return JSON.stringify(part);
    } catch {
      return "";
    }
  }
  return String(part);
}

export function createLogEntrySignature(
  entry: Pick<LogEntry, "type" | "meta">
): string | undefined {
  const signaturePrefix = getMetaValue<string>(entry.meta, "signature_prefix");
  const signatureKeys = getMetaValue<unknown[]>(entry.meta, "signature_keys");

  if (
    typeof signaturePrefix === "string" &&
    Array.isArray(signatureKeys) &&
    signatureKeys.length
  ) {
    const normalizedParts = signatureKeys
      .map((part) => normalizeSignaturePart(part))
      .filter((part) => part.length > 0);

    if (normalizedParts.length) {
      return `${signaturePrefix}${normalizedParts.join("|")}`;
    }
  }

  if (entry.type === "chat.direct") {
    const chatMessage = getMetaValue<Partial<ChatMessage>>(
      entry.meta,
      "chat_message"
    );
    const fromName =
      normalizeSignaturePart(
        getMetaValue<string>(entry.meta, "from_name") ?? chatMessage?.from_name
      ) || undefined;

    if (fromName) {
      return `chat.direct:${fromName}`;
    }
  }

  return undefined;
}

export const hasDeviatedFromCoursePlot = (
  coursePlot: CoursePlot | null | undefined,
  current_sector_id: number,
  falseIfFinished: boolean = false
) => {
  if (!coursePlot) {
    return false;
  }
  if (falseIfFinished && coursePlot.to_sector === current_sector_id) {
    return false;
  }
  return !coursePlot.path.includes(current_sector_id);
};
