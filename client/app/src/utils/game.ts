import { RESOURCE_SHORT_NAMES } from "../types/constants"
import { type CreditsTransferMessage, type WarpTransferMessage } from "../types/messages"

/**
 * Formats a transfer message (credits or warp) into a human-readable summary string.
 *
 * @param transfer - The transfer message containing direction, details, and participant info
 * @returns A formatted string like "Received [credits: 1000] from [PlayerName]" or "Sent [warp_points: 5] to [PlayerName]"
 *
 * @example
 * ```ts
 * const summary = transferSummaryString({
 *   transfer_direction: "received",
 *   transfer_details: { credits: 1000 },
 *   from: { name: "Alice" },
 *   to: { name: "Bob" }
 * });
 * // Returns: "Received [credits: 1000] from [Alice]"
 * ```
 */
export function transferSummaryString(transfer: CreditsTransferMessage | WarpTransferMessage) {
  const { transfer_direction, transfer_details, from, to } = transfer
  const { name: from_name } = from
  const { name: to_name } = to

  const payload: [string, number][] = []

  Object.entries(transfer_details).forEach(([key, value]) => {
    payload.push([key, value])
  })

  const data = {
    direction_long: transfer_direction === "received" ? "received" : "sent",
    direction_short: transfer_direction === "received" ? "from" : "to",
    player_name: transfer_direction === "received" ? from_name : to_name,
    payload: payload,
  }

  return `${
    data.direction_long.charAt(0).toUpperCase() + data.direction_long.slice(1)
  } [${data.payload.map(([key, value]) => `${key}: ${value}`).join(", ")}] ${
    data.direction_short
  } [${data.player_name}]`
}

/**
 * Formats collected salvage data into a human-readable summary string.
 * Includes cargo items (using short names) and credits that were collected.
 *
 * @param salvage - The salvage object containing collected cargo and credits
 * @returns A formatted string like " [QF: 10] [Credits: 500]" or " " if no salvage or error
 *
 * @example
 * ```ts
 * const summary = salvageCollectedSummaryString({
 *   collected: {
 *     cargo: { quantum_foam: 10, retro_organics: 5 },
 *     credits: 500
 *   }
 * });
 * // Returns: " [QF: 10] [RO: 5] [Credits: 500]"
 * ```
 */
export function salvageCollectedSummaryString(salvage: Salvage) {
  try {
    const parts: string[] = []
    const collected = salvage.collected

    // Add cargo items that were collected
    if (collected?.cargo) {
      for (const [resource, amount] of Object.entries(collected.cargo)) {
        if (amount > 0) {
          const shortName = RESOURCE_SHORT_NAMES[resource as Resource]
          parts.push(`[${shortName}: ${amount}]`)
        }
      }
    }

    // Add credits if present and non-zero
    if (collected?.credits && collected.credits > 0) {
      parts.push(`[Credits: ${collected.credits}]`)
    }

    return ` ${parts.join(" ")}`
  } catch {
    return " "
  }
}

/**
 * Formats newly created salvage data into a human-readable summary string.
 * Includes cargo items (using short names), scrap, and credits from destroyed ships or objects.
 *
 * @param salvage - Object containing optional cargo, scrap, and credits from salvage creation
 * @returns A formatted string like " [QF: 10] [Scrap: 25] [Credits: 500]" or " " if no salvage or error
 *
 * @example
 * ```ts
 * const summary = salvageCreatedSummaryString({
 *   cargo: { quantum_foam: 10 },
 *   scrap: 25,
 *   credits: 500
 * });
 * // Returns: " [QF: 10] [Scrap: 25] [Credits: 500]"
 * ```
 */
export function salvageCreatedSummaryString(salvage: {
  cargo?: Record<string, number>
  scrap?: number
  credits?: number
}) {
  try {
    const parts: string[] = []

    if (salvage.cargo) {
      for (const [resource, amount] of Object.entries(salvage.cargo)) {
        if (typeof amount === "number" && amount > 0) {
          const shortName = RESOURCE_SHORT_NAMES[resource as Resource]
          parts.push(`[${shortName}: ${amount}]`)
        }
      }
    }

    if (salvage.scrap && salvage.scrap > 0) {
      parts.push(`[Scrap: ${salvage.scrap}]`)
    }

    if (salvage.credits && salvage.credits > 0) {
      parts.push(`[Credits: ${salvage.credits}]`)
    }

    return ` ${parts.join(" ")}`
  } catch {
    return " "
  }
}

/**
 * Safely extracts a typed value from a meta object.
 * Helper function for accessing metadata properties with type safety.
 *
 * @template T - The expected type of the value
 * @param meta - The metadata object to extract from, may be undefined
 * @param key - The key to lookup in the meta object
 * @returns The value cast to type T if found, otherwise undefined
 *
 * @example
 * ```ts
 * const meta = { signature_prefix: "combat:", round: 5 };
 * const prefix = getMetaValue<string>(meta, "signature_prefix"); // "combat:"
 * const round = getMetaValue<number>(meta, "round"); // 5
 * const missing = getMetaValue<string>(meta, "nonexistent"); // undefined
 * ```
 */
function getMetaValue<T>(meta: Record<string, unknown> | undefined, key: string) {
  if (!meta) {
    return undefined
  }

  return meta[key] as T | undefined
}

/**
 * Normalizes various data types into a consistent string format for signature creation.
 * Handles strings, numbers, booleans, Dates, objects, and null/undefined values.
 *
 * @param part - The value to normalize, can be of any type
 * @returns A normalized string representation:
 *   - Strings are trimmed and lowercased
 *   - Numbers and booleans are converted to strings
 *   - Dates are converted to ISO strings
 *   - Objects are JSON stringified
 *   - null/undefined return empty string
 *
 * @example
 * ```ts
 * normalizeSignaturePart("  Hello  "); // "hello"
 * normalizeSignaturePart(42); // "42"
 * normalizeSignaturePart(true); // "true"
 * normalizeSignaturePart(new Date("2025-01-01")); // "2025-01-01T00:00:00.000Z"
 * normalizeSignaturePart(null); // ""
 * ```
 */
function normalizeSignaturePart(part: unknown) {
  if (part === undefined || part === null) {
    return ""
  }
  if (typeof part === "string") {
    return part.trim().toLowerCase()
  }
  if (typeof part === "number" || typeof part === "boolean") {
    return String(part)
  }
  if (part instanceof Date) {
    return part.toISOString()
  }
  if (typeof part === "object") {
    try {
      return JSON.stringify(part)
    } catch {
      return ""
    }
  }
  return String(part)
}

/**
 * Creates a unique signature string for a log entry based on its type and metadata.
 * Used for deduplication and identification of log entries.
 *
 * The signature is created using one of two methods:
 * 1. If meta contains `signature_prefix` and `signature_keys`, combines them as "prefix|key1|key2|..."
 * 2. For "chat.direct" entries, creates a signature from the sender's name as "chat.direct:name"
 *
 * @param entry - A log entry object with at least type and meta properties
 * @returns A unique signature string if one can be created, otherwise undefined
 *
 * @example
 * ```ts
 * // Using signature_prefix and signature_keys
 * const entry1 = {
 *   type: "combat.round",
 *   meta: {
 *     signature_prefix: "combat:",
 *     signature_keys: ["round_5", "sector_123"]
 *   }
 * };
 * createLogEntrySignature(entry1); // "combat:round_5|sector_123"
 *
 * // Using chat.direct fallback
 * const entry2 = {
 *   type: "chat.direct",
 *   meta: { from_name: "Alice" }
 * };
 * createLogEntrySignature(entry2); // "chat.direct:alice"
 * ```
 */
export function createLogEntrySignature(
  entry: Pick<LogEntry, "type" | "meta">
): string | undefined {
  const signaturePrefix = getMetaValue<string>(entry.meta, "signature_prefix")
  const signatureKeys = getMetaValue<unknown[]>(entry.meta, "signature_keys")

  if (typeof signaturePrefix === "string" && Array.isArray(signatureKeys) && signatureKeys.length) {
    const normalizedParts = signatureKeys
      .map((part) => normalizeSignaturePart(part))
      .filter((part) => part.length > 0)

    if (normalizedParts.length) {
      return `${signaturePrefix}${normalizedParts.join("|")}`
    }
  }

  if (entry.type === "chat.direct") {
    const chatMessage = getMetaValue<Partial<ChatMessage>>(entry.meta, "chat_message")
    const fromName =
      normalizeSignaturePart(
        getMetaValue<string>(entry.meta, "from_name") ?? chatMessage?.from_name
      ) || undefined

    if (fromName) {
      return `chat.direct:${fromName}`
    }
  }

  return undefined
}

/**
 * Compares previous and new map data to find newly discovered sectors.
 * A sector is considered newly discovered when its `visited` property changes
 * from unvisited (undefined/null/empty) to visited (timestamp string).
 *
 * @param prevMapData - The previous map data state
 * @param newMapData - The new map data state
 * @returns Array of newly discovered MapSectorNode objects
 */
export const checkForNewSectors = (
  prevMapData: MapData | null,
  newMapData: MapData
): MapSectorNode[] => {
  // If there's no previous map data, no sectors can be "newly" discovered
  if (!prevMapData) {
    return []
  }

  const newlyDiscovered: MapSectorNode[] = []

  // Check each sector in the new map data
  for (const newSector of newMapData) {
    // Find the corresponding sector in the previous map data
    const prevSector = prevMapData.find((s) => s.id === newSector.id)

    // If the sector exists in both maps, check if visited changed from empty to timestamp
    if (prevSector) {
      const wasUnvisited = !prevSector.visited // falsy (undefined/null/empty)
      const isNowVisited = !!newSector.visited // truthy (timestamp string)

      if (wasUnvisited && isNowVisited) {
        newlyDiscovered.push(newSector)
      }
    }
  }

  return newlyDiscovered
}

export const calculateHopsRemaining = (
  sector: Sector | null | undefined,
  coursePlot: CoursePlot | null | undefined
) => {
  if (!sector || !coursePlot?.path) {
    return 0
  }
  const currentIndex = coursePlot.path.indexOf(sector.id)
  if (currentIndex === -1) {
    return "???"
  }
  return coursePlot.path.length - 1 - currentIndex
}
