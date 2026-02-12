import { useCallback, useEffect, useState } from "react"

import { useStickToBottom } from "use-stick-to-bottom"

interface UseAutoScrollOptions {
  /** Scroll behavior: "smooth" uses spring animation, "instant" jumps immediately (default: "smooth") */
  behavior?: ScrollBehavior
}

interface UseAutoScrollReturn {
  /** Ref to attach to the scroll container element */
  scrollRef: React.RefCallback<HTMLElement> & React.MutableRefObject<HTMLElement | null>
  /** Ref to attach to the content wrapper element */
  contentRef: React.RefCallback<HTMLElement> & React.MutableRefObject<HTMLElement | null>
  /** Whether the scroll is currently at the bottom */
  isAtBottom: boolean
  /** Whether the user has scrolled away from the bottom (locked) */
  isScrollLocked: boolean
  /** Programmatically scroll to the bottom */
  scrollToBottom: () => void
  /** Reset scroll lock and scroll to bottom */
  resetAutoScroll: () => void
  /** Call when new items arrive to track the badge count */
  trackItems: (totalCount: number) => void
  /** Whether there are new items since the user scrolled away */
  hasNewItems: boolean
  /** Dismiss the scroll lock and scroll to bottom */
  dismissLock: () => void
}

/**
 * Hook for managing auto-scroll behavior in scrollable containers.
 * Backed by `use-stick-to-bottom` for reliable, layout-shift-free scrolling.
 *
 * @example
 * ```tsx
 * const {
 *   scrollRef, contentRef, isAtBottom, isScrollLocked,
 *   hasNewItems, dismissLock, trackItems
 * } = useAutoScroll()
 *
 * // Track items for the "new messages" badge
 * useEffect(() => {
 *   trackItems(items.length)
 * }, [items.length, trackItems])
 *
 * return (
 *   <div ref={scrollRef} style={{ overflow: 'auto' }}>
 *     <div ref={contentRef}>
 *       {items.map(item => <Item key={item.id} />)}
 *     </div>
 *     {hasNewItems && <NewItemsBadge onClick={dismissLock} />}
 *   </div>
 * )
 * ```
 */
export function useAutoScroll(options: UseAutoScrollOptions = {}): UseAutoScrollReturn {
  const { behavior = "smooth" } = options

  const animation = behavior === "instant" ? "instant" : behavior

  const {
    scrollRef: stickyScrollRef,
    contentRef,
    scrollToBottom: stickyScrollToBottom,
    stopScroll,
    isAtBottom,
  } = useStickToBottom({
    resize: animation,
    initial: animation,
  })

  // Wrap scrollRef to also attach our own wheel listener that force-stops
  // the animation on upward scroll. The library's built-in detection relies
  // on getComputedStyle(element).overflow matching "scroll" or "auto" exactly,
  // which fails with Radix ScrollArea (overflow-x: hidden, overflow-y: scroll
  // produces "hidden scroll"). Our listener bypasses that check entirely.
  const scrollRef = useCallback(
    (node: HTMLElement | null) => {
      // Detach from previous node
      const prev = stickyScrollRef.current
      if (prev) {
        prev.removeEventListener("wheel", handleWheelEscape)
      }
      // Forward to the library
      stickyScrollRef(node)
      // Attach our escape listener
      if (node) {
        node.addEventListener("wheel", handleWheelEscape, { passive: true })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  ) as React.RefCallback<HTMLElement> & React.MutableRefObject<HTMLElement | null>
  // Mirror the .current property so it works as a MutableRefObject too
  Object.defineProperty(scrollRef, "current", {
    get: () => stickyScrollRef.current,
    set: (v) => {
      stickyScrollRef.current = v
    },
  })

  function handleWheelEscape(e: WheelEvent) {
    if (e.deltaY < 0) {
      stopScroll()
    }
  }

  // Scroll-lock state for "new items" badge
  const [lockState, setLockState] = useState<{ locked: boolean; lockedAt: number }>({
    locked: false,
    lockedAt: 0,
  })
  const [latestCount, setLatestCount] = useState(0)

  // Sync scroll-lock with isAtBottom (queueMicrotask avoids cascading-render lint)
  useEffect(() => {
    queueMicrotask(() => {
      if (isAtBottom) {
        setLockState((prev) => (prev.locked ? { locked: false, lockedAt: 0 } : prev))
      } else {
        setLockState((prev) =>
          prev.locked ? prev : { locked: true, lockedAt: latestCount }
        )
      }
    })
  }, [isAtBottom, latestCount])

  const trackItems = useCallback((totalCount: number) => {
    setLatestCount(totalCount)
  }, [])

  const isScrollLocked = lockState.locked
  const hasNewItems = lockState.locked && latestCount > lockState.lockedAt

  const scrollToBottom = useCallback(() => {
    stickyScrollToBottom(animation)
  }, [stickyScrollToBottom, animation])

  const resetAutoScroll = useCallback(() => {
    setLockState({ locked: false, lockedAt: 0 })
    stickyScrollToBottom(animation)
  }, [stickyScrollToBottom, animation])

  const dismissLock = useCallback(() => {
    setLockState({ locked: false, lockedAt: 0 })
    stickyScrollToBottom("smooth")
  }, [stickyScrollToBottom])

  return {
    scrollRef,
    contentRef,
    isAtBottom,
    isScrollLocked,
    scrollToBottom,
    resetAutoScroll,
    trackItems,
    hasNewItems,
    dismissLock,
  }
}
