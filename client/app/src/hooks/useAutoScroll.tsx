import { useCallback, useRef } from "react"

interface UseAutoScrollOptions {
  /** Threshold in pixels to consider "at bottom" (default: 20) */
  bottomThreshold?: number
  /** Scroll behavior for auto-scroll (default: "smooth") */
  behavior?: ScrollBehavior
}

interface UseAutoScrollReturn {
  /** Component to place at the bottom of the scrollable content */
  AutoScrollAnchor: () => React.ReactElement
  /** Handler to attach to the scroll container's onScroll */
  handleScroll: (event: React.UIEvent<HTMLDivElement>) => void
  /** Imperatively reset auto-scroll to enabled state and scroll to bottom */
  resetAutoScroll: () => void
  /** Scroll to bottom if auto-scroll is enabled (call when content changes) */
  scrollToBottom: () => void
  /** Ref indicating whether auto-scroll is currently enabled (user is at bottom) */
  isAutoScrollEnabledRef: React.RefObject<boolean>
}

/**
 * Hook for managing auto-scroll behavior in scrollable containers.
 *
 * This hook is optimized to never cause re-renders - all state is stored in refs.
 * The returned callbacks are stable and won't change between renders.
 *
 * - Auto-scrolls to bottom when `scrollToBottom()` is called (while enabled)
 * - Disables auto-scroll when user manually scrolls up
 * - Re-enables auto-scroll when user scrolls back to bottom
 * - Provides imperative `resetAutoScroll()` for when content resets (e.g., new task)
 *
 * @example
 * ```tsx
 * const { AutoScrollAnchor, handleScroll, resetAutoScroll, scrollToBottom } = useAutoScroll()
 *
 * // Reset auto-scroll when taskId changes
 * useEffect(() => {
 *   resetAutoScroll()
 * }, [taskId, resetAutoScroll])
 *
 * // Scroll to bottom when items change
 * useEffect(() => {
 *   scrollToBottom()
 * }, [items.length, scrollToBottom])
 *
 * return (
 *   <ScrollArea onScroll={handleScroll}>
 *     {items.map(item => <Item key={item.id} />)}
 *     <AutoScrollAnchor />
 *   </ScrollArea>
 * )
 * ```
 */
export function useAutoScroll(options: UseAutoScrollOptions = {}): UseAutoScrollReturn {
  const { bottomThreshold = 20, behavior = "smooth" } = options

  const bottomRef = useRef<HTMLDivElement>(null)
  // Use ref instead of state to avoid re-renders when scroll position changes
  const isAutoScrollEnabledRef = useRef(true)

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const target = event.currentTarget
      const isAtBottom =
        target.scrollHeight - target.scrollTop - target.clientHeight < bottomThreshold

      // Update ref without causing re-render
      isAutoScrollEnabledRef.current = isAtBottom
    },
    [bottomThreshold]
  )

  const scrollToBottom = useCallback(() => {
    if (isAutoScrollEnabledRef.current) {
      bottomRef.current?.scrollIntoView({ behavior })
    }
  }, [behavior])

  const resetAutoScroll = useCallback(() => {
    isAutoScrollEnabledRef.current = true
    // Scroll to bottom immediately on reset
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior })
    })
  }, [behavior])

  const AutoScrollAnchor = useCallback(
    () => <div ref={bottomRef} className="h-0 w-full" aria-hidden="true" />,
    []
  )

  return {
    AutoScrollAnchor,
    handleScroll,
    resetAutoScroll,
    scrollToBottom,
    isAutoScrollEnabledRef,
  }
}
