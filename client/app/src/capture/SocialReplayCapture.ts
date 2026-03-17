import type { VoiceCapture } from "./VoiceCapture"

// --- SBEC-compatible types (matches sbec-demo/src/types.ts) ---

export type RenderMode = "snapshot" | "sequential"

export interface EventLogComponentEntry {
  componentId: string
  renderMode: RenderMode
  props: Record<string, unknown>
  context?: Record<string, unknown>
  delayMs: number
  expectedDurationMs: number
}

export interface EventLogEntry {
  id: string
  timestamp: number
  sessionTimeMs: number
  eventName: string
  components: EventLogComponentEntry[]
}

export interface EventLogMeta {
  appName: string
  appVersion: string
  userId?: string
  [key: string]: unknown
}

export interface CaptureContext {
  description: string
  mood?: string
}

export interface VoiceCaptureData {
  startTimestamp: number
  durationMs: number
  format: string
  data: string
}

export interface EventLog {
  meta: EventLogMeta
  sessionStartedAt: number
  entries: EventLogEntry[]
  voiceCapture?: {
    playerMic: VoiceCaptureData | null
    botVoice: VoiceCaptureData | null
  }
}

// --- Ring buffer service ---

const BUFFER_DURATION_MS = 90_000

// Events where the most recent entry should always be retained in the capture,
// even if it falls outside the 90-second window. These are snapshot-style events
// where the latest state is needed to render the scene (e.g. the map is always
// visible to the player).
const PINNED_EVENTS = new Set(["map-update", "ship-update", "sector-update"])

export class SocialReplayCapture {
  private entries: EventLogEntry[] = []
  private latestByEvent = new Map<string, EventLogEntry>()
  private sessionStartedAt: number = Date.now()

  playerMicCapture: VoiceCapture | null = null
  botVoiceCapture: VoiceCapture | null = null

  log(eventName: string, components: EventLogComponentEntry[]): void {
    const now = Date.now()

    const entry: EventLogEntry = {
      id: crypto.randomUUID(),
      timestamp: now,
      sessionTimeMs: now - this.sessionStartedAt,
      eventName,
      components,
    }

    // Track the latest entry for pinned event types
    if (PINNED_EVENTS.has(eventName)) {
      this.latestByEvent.set(eventName, entry)
    }

    // Evict stale entries
    const cutoff = now - BUFFER_DURATION_MS
    this.entries = this.entries.filter((e) => e.timestamp >= cutoff)

    this.entries.push(entry)
  }

  async capture(context: CaptureContext): Promise<EventLog> {
    const now = Date.now()
    const cutoff = now - BUFFER_DURATION_MS

    const recentEntries = this.entries.filter((e) => e.timestamp >= cutoff)

    // Ensure pinned events are present even if they aged out of the window.
    // Insert them at the front so they provide baseline state for the renderer.
    const recentIds = new Set(recentEntries.map((e) => e.id))
    const pinnedPrefix: EventLogEntry[] = []
    for (const entry of this.latestByEvent.values()) {
      if (!recentIds.has(entry.id)) {
        pinnedPrefix.push(entry)
      }
    }
    pinnedPrefix.sort((a, b) => a.timestamp - b.timestamp)

    const entries = [...pinnedPrefix, ...recentEntries]

    const [playerMic, botVoice] = await Promise.all([
      this.playerMicCapture?.captureAsBase64() ?? null,
      this.botVoiceCapture?.captureAsBase64() ?? null,
    ])

    return {
      meta: {
        appName: "gradient-bang",
        appVersion: "0.3.5",
        captureContext: context.description,
        captureMood: context.mood,
      },
      sessionStartedAt: this.sessionStartedAt,
      entries,
      voiceCapture: {
        playerMic,
        botVoice,
      },
    }
  }

  async download(context: CaptureContext): Promise<void> {
    const log = await this.capture(context)
    const json = JSON.stringify(log, null, 2)
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `gradient-bang-replay-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
}
