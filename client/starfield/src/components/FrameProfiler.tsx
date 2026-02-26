import { useEffect, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"

import { profileData, resetProfilePeaks } from "@/hooks/useProfiledFrame"

// ---------------------------------------------------------------------------
// FrameProfiler component — only mounted in debug mode via DebugOverlay
// ---------------------------------------------------------------------------

const BAR_CHARS = 10

function bar(value: number, max: number): string {
  const filled = Math.min(BAR_CHARS, Math.round((value / max) * BAR_CHARS))
  return "\u2588".repeat(filled) + "\u2591".repeat(BAR_CHARS - filled)
}

function fmt(ms: number): string {
  return ms.toFixed(2).padStart(6)
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

export function FrameProfiler() {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const gl = useThree((s) => s.gl)
  const frameTimestamps = useRef<number[]>([])
  const frameStartRef = useRef(0)
  const lastFrameTimeRef = useRef(0)

  // Create and mount the overlay div imperatively (avoids R3F reconciler issue)
  useEffect(() => {
    const container = gl.domElement.parentElement
    if (!container) return

    // Wrapper to hold both the text overlay and the reset button
    const wrapper = document.createElement("div")
    Object.assign(wrapper.style, {
      position: "absolute",
      bottom: "8px",
      left: "8px",
      fontFamily: "monospace",
      fontSize: "11px",
      lineHeight: "1.4",
      color: "#0f0",
      background: "rgba(0, 0, 0, 0.85)",
      padding: "8px 10px",
      borderRadius: "4px",
      zIndex: "9999",
    })

    const div = document.createElement("div")
    Object.assign(div.style, {
      whiteSpace: "pre",
      pointerEvents: "none",
    })

    const btn = document.createElement("button")
    btn.textContent = "Reset peaks"
    Object.assign(btn.style, {
      display: "block",
      marginTop: "6px",
      background: "rgba(0, 255, 0, 0.15)",
      border: "1px solid #0f0",
      color: "#0f0",
      fontFamily: "monospace",
      fontSize: "10px",
      padding: "2px 8px",
      borderRadius: "3px",
      cursor: "pointer",
    })
    btn.addEventListener("click", resetProfilePeaks)

    wrapper.appendChild(div)
    wrapper.appendChild(btn)
    container.appendChild(wrapper)
    overlayRef.current = div

    return () => {
      btn.removeEventListener("click", resetProfilePeaks)
      container.removeChild(wrapper)
      overlayRef.current = null
      profileData.objects.clear()
    }
  }, [gl])

  // High-priority: mark frame start + reset renderer info for this frame.
  // Disable autoReset so draw call / triangle counts accumulate across
  // all gl.render() calls in a single frame (mask + composer + overlay).
  useFrame(({ gl: renderer }) => {
    renderer.info.autoReset = false
    renderer.info.reset()
    frameStartRef.current = performance.now()
  }, -Infinity)

  // Shared overlay update function (called from useFrame and rAF idle detector)
  const updateOverlay = () => {
    if (!overlayRef.current) return

    const entries = Array.from(profileData.objects.entries())

    const maxPeak = Math.max(
      0.01,
      ...entries.map(([, o]) => o.peakMs)
    )

    const pp = profileData.ppBreakdown
    const ppMax = Math.max(0.01, pp.maskMs, pp.composerMs, pp.overlayMs)
    const gpu = profileData.gpuTiming

    const idle = profileData.framesPerSecond === 0

    const lines = [
      `FRAME PROFILER${idle ? "  (idle)" : ""}`,
      `${"─".repeat(44)}`,
      `Frame: ${fmt(profileData.frameTotalMs)}ms  │  Frames/s: ${profileData.framesPerSecond}`,
      `Draws: ${profileData.drawCalls.toString().padStart(4)}    │  Tris: ${fmtK(profileData.triangles).padStart(6)}`,
      `${"─".repeat(44)}`,
      `useFrame CPU:      now    peak`,
      ...entries.map(
        ([name, t]) =>
          `  ${name.padEnd(16)} ${fmt(t.lastMs)} ${fmt(t.peakMs)}  ${bar(t.peakMs, maxPeak)}`
      ),
      `${"─".repeat(44)}`,
      `PP CPU (ms):`,
      `  ${"Mask render".padEnd(16)} ${fmt(pp.maskMs)}        ${bar(pp.maskMs, ppMax)}`,
      `  ${"Composer".padEnd(16)} ${fmt(pp.composerMs)}        ${bar(pp.composerMs, ppMax)}`,
      `  ${"Overlay".padEnd(16)} ${fmt(pp.overlayMs)}        ${bar(pp.overlayMs, ppMax)}`,
    ]

    // GPU timing section
    if (gpu.available) {
      const gpuMax = Math.max(0.01, gpu.maskMs, gpu.sceneMs, gpu.effectsMs, gpu.overlayMs)
      lines.push(
        `${"─".repeat(44)}`,
        `PP GPU (ms):       total: ${fmt(gpu.totalMs)}`,
        `  ${"Mask render".padEnd(16)} ${fmt(gpu.maskMs)}        ${bar(gpu.maskMs, gpuMax)}`,
        `  ${"Scene render".padEnd(16)} ${fmt(gpu.sceneMs)}        ${bar(gpu.sceneMs, gpuMax)}`,
        `  ${"Effects".padEnd(16)} ${fmt(gpu.effectsMs)}        ${bar(gpu.effectsMs, gpuMax)}`,
        `  ${"Overlay".padEnd(16)} ${fmt(gpu.overlayMs)}        ${bar(gpu.overlayMs, gpuMax)}`
      )
    } else {
      lines.push(
        `${"─".repeat(44)}`,
        `PP GPU: n/a (no timer query ext)`
      )
    }

    overlayRef.current.textContent = lines.join("\n")
  }

  // Low-priority: compute totals, update overlay
  useFrame(() => {
    const now = performance.now()
    lastFrameTimeRef.current = now
    profileData.frameTotalMs = now - frameStartRef.current

    // Frame counter
    frameTimestamps.current.push(now)
    while (
      frameTimestamps.current.length > 0 &&
      frameTimestamps.current[0] < now - 1000
    ) {
      frameTimestamps.current.shift()
    }
    profileData.framesPerSecond = frameTimestamps.current.length

    // Renderer info (accumulated across all gl.render() calls this frame)
    const info = gl.info
    profileData.drawCalls = info.render.calls
    profileData.triangles = info.render.triangles
    profileData.programs = info.programs?.length ?? 0

    updateOverlay()
  }, Infinity)

  // Independent rAF loop to detect idle state (no R3F frames rendering)
  useEffect(() => {
    let rafId: number
    const check = () => {
      const now = performance.now()
      const elapsed = now - lastFrameTimeRef.current
      // If no frame has rendered in 500ms, scene is idle
      if (lastFrameTimeRef.current > 0 && elapsed > 500) {
        // Expire old frame timestamps
        while (
          frameTimestamps.current.length > 0 &&
          frameTimestamps.current[0] < now - 1000
        ) {
          frameTimestamps.current.shift()
        }
        profileData.framesPerSecond = frameTimestamps.current.length
        updateOverlay()
      }
      rafId = requestAnimationFrame(check)
    }
    rafId = requestAnimationFrame(check)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return null
}
