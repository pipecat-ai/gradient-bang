import { useCallback, useRef } from "react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

interface TutorialRevealOverlayProps {
  id: string
}

function runRevealAnimation(canvas: HTMLCanvasElement, onDone: () => void) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return

  const dpr = Math.min(window.devicePixelRatio, 2)
  const rect = canvas.getBoundingClientRect()
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)

  const w = rect.width
  const h = rect.height
  const cx = w / 2
  const cy = h / 2
  const duration = 800
  const start = performance.now()

  const style = getComputedStyle(document.documentElement)
  const color = style.getPropertyValue("--color-success").trim() || "#22c55e"

  const frame = (now: number) => {
    const t = Math.min((now - start) / duration, 1)
    const e = 1 - Math.pow(1 - t, 3)

    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.shadowColor = color
    ctx.shadowBlur = 6

    const corners: [number, number][] = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]

    for (const [ex, ey] of corners) {
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + (ex - cx) * e, cy + (ey - cy) * e)
      ctx.stroke()
    }

    if (e > 0.8) {
      const bt = (e - 0.8) / 0.2
      const len = 20 * bt
      ctx.lineWidth = 2
      ctx.shadowBlur = 8
      for (const [ex, ey] of corners) {
        const dx = ex === 0 ? 1 : -1
        const dy = ey === 0 ? 1 : -1
        ctx.beginPath()
        ctx.moveTo(ex + dx * len, ey)
        ctx.lineTo(ex, ey)
        ctx.lineTo(ex, ey + dy * len)
        ctx.stroke()
      }
    }

    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
      // Blink 4 times then clear
      let blinks = 0
      const totalBlinks = 4
      const blinkInterval = setInterval(() => {
        blinks++
        if (blinks % 2 === 1) {
          ctx.clearRect(0, 0, w, h)
        } else {
          // Redraw fully expanded state
          ctx.clearRect(0, 0, w, h)
          ctx.strokeStyle = color
          ctx.lineWidth = 1
          ctx.shadowColor = color
          ctx.shadowBlur = 6
          for (const [ex, ey] of corners) {
            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.lineTo(ex, ey)
            ctx.stroke()
          }
          ctx.lineWidth = 2
          ctx.shadowBlur = 8
          const len = 20
          for (const [ex, ey] of corners) {
            const dx = ex === 0 ? 1 : -1
            const dy = ey === 0 ? 1 : -1
            ctx.beginPath()
            ctx.moveTo(ex + dx * len, ey)
            ctx.lineTo(ex, ey)
            ctx.lineTo(ex, ey + dy * len)
            ctx.stroke()
          }
        }
        if (blinks >= totalBlinks * 2) {
          clearInterval(blinkInterval)
          ctx.clearRect(0, 0, w, h)
          onDone()
        }
      }, 100)
    }
  }

  requestAnimationFrame(frame)
}

export const TutorialRevealOverlay = ({ id }: TutorialRevealOverlayProps) => {
  const tutorialActive = useGameStore((state) => state.tutorialActive)
  const tutorialStep = useGameStore((state) => state.tutorialStep)
  const tutorialRevealed = useGameStore((state) => state.tutorialRevealed)
  const revealTutorialElement = useGameStore((state) => state.revealTutorialElement)
  const hasAnimated = useRef(false)

  const isRevealed = tutorialRevealed.includes(id)
  const isTargeted = tutorialStep?.target === id
  const isIdle = !isRevealed && !isTargeted

  const canvasCallback = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !isTargeted || isRevealed || hasAnimated.current) return
      hasAnimated.current = true
      useAudioStore.getState().playSound("chime9", { volume: 0.5 })
      revealTutorialElement(id)
      runRevealAnimation(canvas, () => {})
    },
    [isTargeted, isRevealed, id, revealTutorialElement]
  )

  if (!tutorialActive) return null

  if (isIdle) {
    return (
      <div
        className="absolute inset-0 z-50 pointer-events-none cross-lines-muted-foreground/40 flex items-center justify-center animate-pulse"
        data-tutorial-overlay
      >
        <span className="relative z-10 bg-black border border-muted-foreground/40 px-2.5 py-1 text-xxs font-semibold font-mono text-muted-foreground">
          OFFLINE
        </span>
      </div>
    )
  }

  return (
    <canvas
      key={isTargeted ? "active" : "done"}
      ref={canvasCallback}
      className="absolute inset-0 z-50 w-full h-full pointer-events-none"
      data-tutorial-overlay
    />
  )
}
