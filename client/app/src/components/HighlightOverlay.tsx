import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"

import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

interface HighlightOverlayProps {
  className?: string
  offset?: number
  autoClearDuration?: number
  elementRefs?: Record<string, HTMLElement | null>
}

export const HighlightOverlay = ({
  className = "ring-4",
  offset = 4,
  autoClearDuration = 3000,
  elementRefs = {},
}: HighlightOverlayProps) => {
  const highlightedElement = useGameStore.use.highlightElement()
  const setHighlightElement = useGameStore.use.setHighlightElement()
  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
    height: number
  } | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const scrollHandlerRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)

  const targetElementId = highlightedElement
  const targetElement = useMemo(() => {
    if (!targetElementId) return null

    // Prefer provided refs map
    const refMatch = elementRefs[targetElementId] ?? null
    if (refMatch) return refMatch

    // Fallback to DOM lookup by id (supports optional leading '#')
    if (typeof document === "undefined") return null
    const domId = targetElementId.startsWith("#") ? targetElementId.slice(1) : targetElementId
    return document.getElementById(domId)
  }, [elementRefs, targetElementId])
  const [isReady, setIsReady] = useState(false)
  const [animationKey, setAnimationKey] = useState(0)
  const isActive = !!targetElementId && !!targetElement && isReady

  // Track previous target to detect changes
  const prevTargetRef = useRef<HTMLElement | null>(null)

  // Adjust state during rendering when target changes
  // (avoids synchronous setState inside useEffect – React 19 requirement)
  if (prevTargetRef.current !== targetElement) {
    prevTargetRef.current = targetElement
    setPosition(null)
    setIsReady(false)
    if (targetElement) {
      setAnimationKey((prev) => prev + 1)
    }
  }

  const updatePosition = useCallback(() => {
    if (!targetElement) return

    const rect = targetElement.getBoundingClientRect()
    setPosition({
      // Use viewport coordinates because overlay is position: fixed
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    })
  }, [targetElement])

  // Auto-clear timer - runs regardless of DOM element existence
  useEffect(() => {
    if (!targetElementId || autoClearDuration <= 0) {
      return
    }

    // Set up auto-clear timeout
    timeoutRef.current = window.setTimeout(() => {
      setHighlightElement(null)
    }, autoClearDuration)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [targetElementId, autoClearDuration, setHighlightElement])

  // DOM positioning and ResizeObserver - only runs if element exists
  useEffect(() => {
    if (!targetElement || !targetElementId) {
      return
    }

    // Wait for next paint cycle and ensure element is ready
    const checkElementReady = () => {
      const rect = targetElement.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        updatePosition()
        setIsReady(true)
      } else {
        requestAnimationFrame(checkElementReady)
      }
    }

    requestAnimationFrame(checkElementReady)

    // Set up ResizeObserver
    observerRef.current = new ResizeObserver(() => {
      updatePosition()
    })

    // Observe the target element and its ancestors for layout changes
    let currentElement: Element | null = targetElement
    while (currentElement && currentElement !== document.body) {
      observerRef.current.observe(currentElement)
      currentElement = currentElement.parentElement
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
    }
  }, [targetElement, targetElementId, updatePosition])

  // Throttled scroll handler
  useEffect(() => {
    if (!isActive || !targetElement) return

    const handleScroll = () => {
      if (scrollHandlerRef.current) {
        cancelAnimationFrame(scrollHandlerRef.current)
      }

      scrollHandlerRef.current = requestAnimationFrame(() => {
        updatePosition()
      })
    }

    window.addEventListener("scroll", handleScroll, { passive: true })

    return () => {
      window.removeEventListener("scroll", handleScroll)
      if (scrollHandlerRef.current) {
        cancelAnimationFrame(scrollHandlerRef.current)
      }
    }
  }, [isActive, targetElement, updatePosition])

  if (!isActive || !position) return null

  return createPortal(
    <div
      key={animationKey}
      className={cn("fixed pointer-events-none z-50 animate-highlight ring-terminal", className)}
      style={
        {
          top: position.top - offset,
          left: position.left - offset,
          width: position.width + offset * 2,
          height: position.height + offset * 2,
          "--highlight-final-opacity": autoClearDuration > 0 ? "0" : "1",
        } as React.CSSProperties & { "--highlight-final-opacity": string }
      }
    />,
    document.body
  )
}
