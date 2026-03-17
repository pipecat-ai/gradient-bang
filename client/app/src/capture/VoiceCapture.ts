const CHUNK_INTERVAL_MS = 5_000
const BUFFER_DURATION_MS = 90_000
const MIME_TYPE = "audio/webm;codecs=opus"

interface AudioChunk {
  blob: Blob
  timestamp: number
}

export class VoiceCapture {
  private headerChunk: AudioChunk | null = null
  private chunks: AudioChunk[] = []
  private recorder: MediaRecorder | null = null
  private evictTimer: ReturnType<typeof setInterval> | null = null

  start(track: MediaStreamTrack): void {
    this.stop()

    const stream = new MediaStream([track])

    if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
      console.warn("[VoiceCapture] MIME type not supported:", MIME_TYPE)
      return
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: MIME_TYPE,
      audioBitsPerSecond: 32_000,
    })

    let isFirstChunk = true

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        const chunk: AudioChunk = { blob: e.data, timestamp: Date.now() }
        if (isFirstChunk) {
          // The first chunk contains the EBML header + Tracks metadata.
          // Without it, the concatenated webm is unplayable. Keep it forever.
          this.headerChunk = chunk
          isFirstChunk = false
        }
        this.chunks.push(chunk)
      }
    }

    recorder.start(CHUNK_INTERVAL_MS)
    this.recorder = recorder

    // Periodically evict old chunks (but never the header)
    this.evictTimer = setInterval(() => {
      const cutoff = Date.now() - BUFFER_DURATION_MS
      this.chunks = this.chunks.filter((c) => c === this.headerChunk || c.timestamp >= cutoff)
    }, CHUNK_INTERVAL_MS)
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop()
    }
    this.recorder = null
    if (this.evictTimer) {
      clearInterval(this.evictTimer)
      this.evictTimer = null
    }
  }

  async captureAsBase64(): Promise<{
    startTimestamp: number
    durationMs: number
    format: string
    data: string
  } | null> {
    if (this.chunks.length === 0) return null

    const cutoff = Date.now() - BUFFER_DURATION_MS
    const recentChunks = this.chunks.filter((c) => c.timestamp >= cutoff)
    if (recentChunks.length === 0) return null

    // Always lead with the header chunk (EBML + Tracks) so the file is playable.
    // If the header chunk is already in recentChunks (session < 90s), avoid duplication.
    const headerIncluded = this.headerChunk && recentChunks[0] === this.headerChunk
    const validChunks =
      this.headerChunk && !headerIncluded ? [this.headerChunk, ...recentChunks] : recentChunks

    const startTimestamp = recentChunks[0].timestamp
    const endTimestamp = recentChunks[recentChunks.length - 1].timestamp + CHUNK_INTERVAL_MS
    const durationMs = endTimestamp - startTimestamp

    const blob = new Blob(
      validChunks.map((c) => c.blob),
      { type: MIME_TYPE }
    )

    const data = await blobToBase64(blob)

    return {
      startTimestamp,
      durationMs,
      format: MIME_TYPE,
      data,
    }
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // Strip data URL prefix: "data:audio/webm;codecs=opus;base64,"
      const base64 = result.split(",")[1] ?? ""
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
