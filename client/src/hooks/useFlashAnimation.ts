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
  trigger: number | undefined, // The value that changes to trigger the flash
  options: UseFlashAnimationOptions = {}
) => {
  const { duration = 800, flashDelay = 0 } = options;

  const [isFlashing, setIsFlashing] = useState(false);
  const [flashColor, setFlashColor] = useState<
    "primary" | "active" | "inactive"
  >("primary");
  const timeoutRef = useRef<number | undefined>(undefined);
  const previousTriggerRef = useRef<number | undefined>(undefined);
  const isFirstRenderRef = useRef(true);
  const isFlashingRef = useRef(false);
  const lastProcessedValueRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Skip animation on first render
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      previousTriggerRef.current = trigger;
      return;
    }

    // Only trigger flash if the value actually changed and we're not already flashing
    // Also ensure we haven't already processed this exact value
    if (
      trigger !== previousTriggerRef.current &&
      trigger !== undefined &&
      !isFlashingRef.current &&
      trigger !== lastProcessedValueRef.current
    ) {
      const previousValue = previousTriggerRef.current;

      // Don't flash when transitioning from undefined to a number
      if (previousValue === undefined) {
        previousTriggerRef.current = trigger;
        return;
      }

      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Determine flash color based on whether value increased or decreased
      const isIncrease =
        typeof trigger === "number" &&
        typeof previousValue === "number" &&
        trigger > previousValue;
      const flashColorToUse = isIncrease ? "active" : "inactive";

      console.log(
        `[FLASH] Triggering flash: ${previousValue} -> ${trigger}, color: ${flashColorToUse}`
      );

      // Update the previous value immediately to prevent double triggers
      previousTriggerRef.current = trigger;
      lastProcessedValueRef.current = trigger;

      // Start the flash animation after the specified delay
      timeoutRef.current = setTimeout(() => {
        isFlashingRef.current = true;
        setIsFlashing(true);
        setFlashColor(flashColorToUse);

        // End the flash animation and reset color
        setTimeout(() => {
          isFlashingRef.current = false;
          setIsFlashing(false);
          setFlashColor("primary");
        }, duration);
      }, flashDelay);
    }

    // Cleanup function
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [trigger, duration, flashDelay]);

  // Cleanup on unmount
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
      // Manual trigger function if needed
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      isFlashingRef.current = true;
      setIsFlashing(true);
      setFlashColor("active"); // Default to active for manual triggers

      setTimeout(() => {
        setFlashColor("primary");
      }, duration / 2);

      setTimeout(() => {
        isFlashingRef.current = false;
        setIsFlashing(false);
      }, duration);
    },
  };
};
