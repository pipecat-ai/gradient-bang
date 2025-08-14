import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUI } from "../hooks/useUI";

interface HighlightOverlayProps {
  className?: string;
  offset?: number;
  autoClearDuration?: number;
}

export const HighlightOverlay = ({
  className = "ring-4",
  offset = 4,
  autoClearDuration = 3000,
}: HighlightOverlayProps) => {
  const { ui, highlightPanel } = useUI();
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const scrollHandlerRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const targetPanel = ui.highlightedPanel;
  const targetElement = targetPanel ? ui.panelRefs[targetPanel] : null;
  const [isReady, setIsReady] = useState(false);
  const [animationKey, setAnimationKey] = useState(0);
  const isActive = !!targetPanel && !!targetElement && isReady;

  // Track previous target to detect changes
  const prevTargetRef = useRef<HTMLElement | null>(null);

  const updatePosition = useCallback(() => {
    if (!targetElement) return;

    const rect = targetElement.getBoundingClientRect();
    setPosition({
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height,
    });
  }, [targetElement]);

  // Auto-clear timer - runs regardless of DOM element existence
  useEffect(() => {
    if (!targetPanel || autoClearDuration <= 0) {
      return;
    }

    // Set up auto-clear timeout
    timeoutRef.current = window.setTimeout(() => {
      highlightPanel(null);
    }, autoClearDuration);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [targetPanel, autoClearDuration, highlightPanel]);

  // DOM positioning and ResizeObserver - only runs if element exists
  useEffect(() => {
    // Immediately clear position when target changes
    if (!targetElement || !targetPanel) {
      setPosition(null);
      setIsReady(false);
      prevTargetRef.current = null;
      return;
    }

    // If target element changed, reset ready state and animation
    if (prevTargetRef.current !== targetElement) {
      setIsReady(false);
      setPosition(null);
      setAnimationKey((prev) => prev + 1);
      prevTargetRef.current = targetElement;
    }

    // Wait for next paint cycle and ensure element is ready
    const checkElementReady = () => {
      const rect = targetElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        updatePosition();
        setIsReady(true);
      } else {
        requestAnimationFrame(checkElementReady);
      }
    };

    requestAnimationFrame(checkElementReady);

    // Set up ResizeObserver
    observerRef.current = new ResizeObserver(() => {
      updatePosition();
    });

    // Observe the target element and its ancestors for layout changes
    let currentElement: Element | null = targetElement;
    while (currentElement && currentElement !== document.body) {
      observerRef.current.observe(currentElement);
      currentElement = currentElement.parentElement;
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [targetElement, targetPanel, updatePosition]);

  // Throttled scroll handler
  useEffect(() => {
    if (!isActive || !targetElement) return;

    const handleScroll = () => {
      if (scrollHandlerRef.current) {
        cancelAnimationFrame(scrollHandlerRef.current);
      }

      scrollHandlerRef.current = requestAnimationFrame(() => {
        updatePosition();
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollHandlerRef.current) {
        cancelAnimationFrame(scrollHandlerRef.current);
      }
    };
  }, [isActive, targetElement, updatePosition]);

  if (!isActive || !position) return null;

  return createPortal(
    <div
      key={animationKey}
      className={`fixed pointer-events-none z-50 highlight-animation ${className}`}
      style={{
        top: position.top - offset,
        left: position.left - offset,
        width: position.width + offset * 2,
        height: position.height + offset * 2,
      }}
    />,
    document.body
  );
};
