import { useEffect, useRef, useState } from "react";

/**
 * Hook that triggers a flash animation when a value changes.
 * Returns the current flash color and state for use in UI components.
 * Uses "active" color for increases and "inactive" color for decreases.
 *
 * @param trigger - The numerical value that changes to trigger the flash animation
 * @param options - Configuration options for the flash animation
 * @returns Object containing flash state, color, and manual trigger function
 */
interface UseFlashAnimationOptions {
  duration?: number; // Total flash duration in milliseconds
  flashDelay?: number; // Delay before starting the flash in milliseconds
}

export const useFlashAnimation = (
  trigger: number | undefined,
  options: UseFlashAnimationOptions = {}
) => {
  const { duration = 800, flashDelay = 0 } = options;

  const [isFlashing, setIsFlashing] = useState(false);
  const [flashColor, setFlashColor] = useState<
    "idle" | "increment" | "decrement"
  >("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const previousTriggerRef = useRef<number | undefined>(undefined);
  const isFirstRenderRef = useRef(true);
  const isFlashingRef = useRef(false);
  const lastProcessedValueRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      previousTriggerRef.current = trigger;
      lastProcessedValueRef.current = trigger;
      return;
    }

    if (
      trigger !== previousTriggerRef.current &&
      trigger !== undefined &&
      !isFlashingRef.current &&
      trigger !== lastProcessedValueRef.current
    ) {
      const previousValue = previousTriggerRef.current;

      // Skip flash if previous value was undefined (initial load)
      if (previousValue === undefined) {
        previousTriggerRef.current = trigger;
        lastProcessedValueRef.current = trigger;
        return;
      }

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      const isIncrease =
        typeof trigger === "number" &&
        typeof previousValue === "number" &&
        trigger > previousValue;
      const flashColorToUse = isIncrease ? "increment" : "decrement";

      previousTriggerRef.current = trigger;
      lastProcessedValueRef.current = trigger;

      timeoutRef.current = setTimeout(() => {
        isFlashingRef.current = true;
        setIsFlashing(true);
        setFlashColor(flashColorToUse);

        setTimeout(() => {
          isFlashingRef.current = false;
          setIsFlashing(false);
          setFlashColor("idle");
        }, duration);
      }, flashDelay);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [trigger, duration, flashDelay]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return {
    isFlashing,
    flashColor,
    triggerFlash: () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      isFlashingRef.current = true;
      setIsFlashing(true);
      setFlashColor("increment");

      setTimeout(() => {
        setFlashColor("idle");
      }, duration / 2);

      setTimeout(() => {
        isFlashingRef.current = false;
        setIsFlashing(false);
      }, duration);
    },
  };
};
