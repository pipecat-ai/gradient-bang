import React, { useEffect, useRef, useState } from "react"

const MAX_THINKING_MS = 30_000

interface ThinkingProps {
  "aria-label"?: string
  className?: string
  initialDots?: number
  interval?: number
  maxDots?: number
  startTime?: string | number
}

export const Thinking: React.FC<ThinkingProps> = ({
  "aria-label": ariaLabel = "Loading",
  className = "",
  initialDots = 1,
  interval = 500,
  maxDots = 3,
  startTime,
}) => {
  const [dots, setDots] = useState(initialDots)
  const [expired, setExpired] = useState(false)
  const timerRef = useRef<HTMLSpanElement>(null)
  const rafRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const i = setInterval(() => {
      setDots((prevDots) => (prevDots % maxDots) + 1)
    }, interval)

    return () => clearInterval(i)
  }, [interval, maxDots])

  const start =
    startTime === undefined ? undefined
    : typeof startTime === "string" ? new Date(startTime).getTime()
    : startTime

  useEffect(() => {
    if (start === undefined) return

    const remaining = Math.max(0, MAX_THINKING_MS - (Date.now() - start))
    const expiry = setTimeout(() => setExpired(true), remaining)

    const tick = () => {
      if (timerRef.current) {
        const elapsed = (Date.now() - start) / 1000
        timerRef.current.textContent = `${elapsed.toFixed(1)}s`
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      clearTimeout(expiry)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [start])

  if (expired) return null

  const renderDots = () => {
    return ".".repeat(dots)
  }

  return (
    <span className={className} aria-label={ariaLabel}>
      {renderDots()}
      {startTime && <span ref={timerRef} className="ml-1 opacity-50 tabular-nums" />}
    </span>
  )
}

export default Thinking
