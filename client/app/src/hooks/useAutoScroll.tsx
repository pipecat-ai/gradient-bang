import { useCallback, useEffect, useLayoutEffect, useState } from "react"

import { useStickToBottom } from "use-stick-to-bottom"

interface UseAutoScrollOptions {
  /** Scroll behavior for new content: "smooth" uses spring animation, "instant" jumps immediately (default: "smooth") */
  behavior?: ScrollBehavior
  /** Start at the bottom without any visible scroll on mount (default: false) */
  startAtBottom?: boolean
}

interface UseAutoScrollReturn {
  /** Ref to attach to the scroll container element */
  scrollRef: React.RefCallback<HTMLElement> & React.MutableRefObject<HTMLElement | null>
  /** Ref to attach to the content wrapper element */
  contentRef: React.RefCallback<HTMLElement> & React.MutableRefObject<HTMLElement | null>
  /** Whether the scroll is currently at the bottom */
  isAtBottom: boolean
  /** Programmatically scroll to the bottom */
  scrollToBottom: () => void
  /** Reset auto-scroll by jumping to the bottom (alias for scrollToBottom) */
  resetAutoScroll: () => void
  /** Report the current item count so the hook can detect "new since seen" */
  trackItems: (count: number) => void
  /** True when off-bottom AND content has grown since the last time we were at bottom */
  hasNewItems: boolean
  /** Jump to the bottom (used by the "jump to latest" button) */
  dismissLock: () => void
}

/**
 * Thin wrapper over `use-stick-to-bottom`. The library handles stick-to-bottom,
 * user-escape, and auto-scroll on new content. This hook adds one extra signal:
 * `hasNewItems`, which is true only when the viewport is off-bottom AND the
 * caller-reported item count has grown since the last time we were at bottom.
 */
export function useAutoScroll(options: UseAutoScrollOptions = {}): UseAutoScrollReturn {
  const { behavior = "smooth", startAtBottom = false } = options

  const animation = behavior === "instant" ? "instant" : behavior

  const {
    scrollRef,
    contentRef,
    scrollToBottom: stickyScrollToBottom,
    isAtBottom,
  } = useStickToBottom({
    resize: animation,
    initial: startAtBottom ? false : animation,
  })

  useLayoutEffect(() => {
    if (startAtBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [startAtBottom, scrollRef])

  const [latestCount, setLatestCount] = useState(0)
  const [seenCount, setSeenCount] = useState(0)

  // Whenever the viewport is at the bottom, the current count is "seen".
  useEffect(() => {
    if (isAtBottom) setSeenCount(latestCount)
  }, [isAtBottom, latestCount])

  const trackItems = useCallback((count: number) => {
    setLatestCount(count)
  }, [])

  const scrollToBottom = useCallback(() => {
    stickyScrollToBottom(animation)
  }, [stickyScrollToBottom, animation])

  const dismissLock = useCallback(() => {
    stickyScrollToBottom("smooth")
  }, [stickyScrollToBottom])

  return {
    scrollRef,
    contentRef,
    isAtBottom,
    scrollToBottom,
    resetAutoScroll: scrollToBottom,
    trackItems,
    hasNewItems: !isAtBottom && latestCount > seenCount,
    dismissLock,
  }
}
