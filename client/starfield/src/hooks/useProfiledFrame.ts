import { useFrame } from "@react-three/fiber"
import type { RootState } from "@react-three/fiber"

import { useGameStore } from "@/useGameStore"

// ---------------------------------------------------------------------------
// Profiling data store (plain mutable object — not Zustand, zero overhead)
// ---------------------------------------------------------------------------

interface ObjectTiming {
  lastMs: number
  avgMs: number
  /** Decaying recent-max — shows where spikes reached, fades over ~2s */
  peakMs: number
  samples: number[]
}

interface PPBreakdown {
  maskMs: number
  composerMs: number
  overlayMs: number
}

interface GPUTimingData {
  /** Whether the GPU timer query extension is available */
  available: boolean
  /** Per-pass GPU timings (ms) — updated asynchronously, 1-2 frames behind */
  maskMs: number
  composerMs: number
  overlayMs: number
  /** Total GPU time for all three passes */
  totalMs: number
}

interface ProfileData {
  /** Per-object useFrame CPU timings */
  objects: Map<string, ObjectTiming>
  /** Post-processing sub-pass breakdown (CPU dispatch time) */
  ppBreakdown: PPBreakdown
  /** GPU timing for post-processing passes */
  gpuTiming: GPUTimingData
  /** Total frame time (start to end of all useFrame callbacks) */
  frameTotalMs: number
  /** Rolling frame count over 1 second */
  framesPerSecond: number
  /** renderer.info snapshot */
  drawCalls: number
  triangles: number
  programs: number
}

/** Shared profiling data — written by useProfiledFrame, read by FrameProfiler */
export const profileData: ProfileData = {
  objects: new Map(),
  ppBreakdown: { maskMs: 0, composerMs: 0, overlayMs: 0 },
  gpuTiming: {
    available: false,
    maskMs: 0,
    composerMs: 0,
    overlayMs: 0,
    totalMs: 0,
  },
  frameTotalMs: 0,
  framesPerSecond: 0,
  drawCalls: 0,
  triangles: 0,
  programs: 0,
}

const SAMPLE_WINDOW = 60 // rolling average over N frames

/** Peak decay factor — multiplied each frame so peak fades over ~2s at 60fps */
const PEAK_DECAY = 0.97

/** Report a timing from useProfiledFrame */
export function reportTiming(name: string, ms: number) {
  let entry = profileData.objects.get(name)
  if (!entry) {
    entry = { lastMs: 0, avgMs: 0, peakMs: 0, samples: [] }
    profileData.objects.set(name, entry)
  }
  entry.lastMs = ms
  entry.peakMs = Math.max(ms, entry.peakMs * PEAK_DECAY)
  entry.samples.push(ms)
  if (entry.samples.length > SAMPLE_WINDOW) entry.samples.shift()
  entry.avgMs =
    entry.samples.reduce((a, b) => a + b, 0) / entry.samples.length
}

/** Reset all peak values and samples */
export function resetProfilePeaks() {
  for (const entry of profileData.objects.values()) {
    entry.peakMs = 0
    entry.samples = []
  }
  profileData.ppBreakdown.maskMs = 0
  profileData.ppBreakdown.composerMs = 0
  profileData.ppBreakdown.overlayMs = 0
  profileData.gpuTiming.maskMs = 0
  profileData.gpuTiming.composerMs = 0
  profileData.gpuTiming.overlayMs = 0
  profileData.gpuTiming.totalMs = 0
}

// ---------------------------------------------------------------------------
// GPUTimer — async GPU timing via EXT_disjoint_timer_query_webgl2
// ---------------------------------------------------------------------------

interface PendingQuery {
  label: string
  query: WebGLQuery
  startFrame: number
}

/**
 * Wraps WebGL2 timer queries for per-pass GPU timing.
 * Only one query can be active at a time (WebGL limitation).
 * Results arrive 1-2 frames late (async GPU readback).
 * When the extension is unavailable (Safari/iOS), all methods are no-ops.
 */
export class GPUTimer {
  private gl: WebGL2RenderingContext
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
  private pending: PendingQuery[] = []
  private results = new Map<string, number>()
  private frameCount = 0

  constructor(glContext: WebGL2RenderingContext) {
    this.gl = glContext
    this.ext = glContext.getExtension(
      "EXT_disjoint_timer_query_webgl2"
    ) as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null

    profileData.gpuTiming.available = this.ext !== null
  }

  get isAvailable(): boolean {
    return this.ext !== null
  }

  /** Begin timing a labeled pass. End must be called before beginning another. */
  begin(label: string): void {
    if (!this.ext) return
    const query = this.gl.createQuery()
    if (!query) return
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query)
    this.pending.push({ label, query, startFrame: this.frameCount })
  }

  /** End the current timing pass. */
  end(): void {
    if (!this.ext) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
  }

  /**
   * Collect completed query results. Call once per frame.
   * Updates profileData.gpuTiming with the latest results.
   */
  collect(): void {
    this.frameCount++
    if (!this.ext) return

    // Clear previous results so stale labels don't persist
    this.results.clear()

    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)
    const stillPending: PendingQuery[] = []

    for (const entry of this.pending) {
      const available = this.gl.getQueryParameter(
        entry.query,
        this.gl.QUERY_RESULT_AVAILABLE
      )

      if (available) {
        if (!disjoint) {
          const nanos = this.gl.getQueryParameter(
            entry.query,
            this.gl.QUERY_RESULT
          )
          this.results.set(entry.label, nanos / 1e6)
        }
        this.gl.deleteQuery(entry.query)
      } else if (this.frameCount - entry.startFrame > 5) {
        // Too old, discard to avoid leaking
        this.gl.deleteQuery(entry.query)
      } else {
        stillPending.push(entry)
      }
    }

    this.pending = stillPending

    // Update profileData only when new results arrive (preserves reset zeros)
    const gpu = profileData.gpuTiming
    if (this.results.has("mask")) gpu.maskMs = this.results.get("mask")!
    if (this.results.has("composer"))
      gpu.composerMs = this.results.get("composer")!
    if (this.results.has("overlay"))
      gpu.overlayMs = this.results.get("overlay")!
    gpu.totalMs = gpu.maskMs + gpu.composerMs + gpu.overlayMs
  }

  dispose(): void {
    for (const entry of this.pending) {
      this.gl.deleteQuery(entry.query)
    }
    this.pending = []
    this.results.clear()
  }
}

/** Report post-processing sub-pass timings */
export function reportPPBreakdown(
  maskMs: number,
  composerMs: number,
  overlayMs: number
) {
  profileData.ppBreakdown.maskMs = maskMs
  profileData.ppBreakdown.composerMs = composerMs
  profileData.ppBreakdown.overlayMs = overlayMs
}

// ---------------------------------------------------------------------------
// useProfiledFrame — drop-in replacement for useFrame
// ---------------------------------------------------------------------------

/**
 * When debug is true, wraps the callback with CPU timing.
 * When debug is false, calls useFrame directly with zero overhead.
 */
export function useProfiledFrame(
  name: string,
  callback: (state: RootState, delta: number) => void,
  priority?: number
) {
  const debug = useGameStore.getState().debug

  useFrame(
    debug
      ? (state, delta) => {
          const t0 = performance.now()
          callback(state, delta)
          reportTiming(name, performance.now() - t0)
        }
      : callback,
    priority
  )
}
