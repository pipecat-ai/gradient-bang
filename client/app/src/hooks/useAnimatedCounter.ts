import { useEffect, useRef, useState } from "react";

/**
 * Hook that animates a numerical value from its current state to a target value
 * with smooth easing animation, similar to a money counter effect.
 *
 * @param targetValue - The target value to animate to
 * @param options - Configuration options for the animation
 * @returns Object containing the current display value, animation state, and target value
 */
interface UseAnimatedCounterOptions {
  duration?: number; // Animation duration in milliseconds
  easing?: (t: number) => number; // Easing function
  precision?: number; // Number of decimal places to round to
}

// Ease-out cubic function for smooth deceleration
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const useAnimatedCounter = (
  targetValue: number | undefined,
  options: UseAnimatedCounterOptions = {}
) => {
  const { duration = 1000, easing = easeOutCubic, precision = 0 } = options;

  const [displayValue, setDisplayValue] = useState<number>(targetValue ?? 0);
  const [isAnimating, setIsAnimating] = useState(false);
  const animationRef = useRef<number | undefined>(undefined);
  const startTimeRef = useRef<number | undefined>(undefined);
  const startValueRef = useRef<number>(targetValue ?? 0);
  const isFirstRenderRef = useRef(true);

  useEffect(() => {
    if (targetValue === undefined) {
      setDisplayValue(0);
      return;
    }

    // On first render when going from undefined to a number, set immediately without animation
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      setDisplayValue(targetValue);
      startValueRef.current = targetValue;
      return;
    }

    // If the value hasn't changed, don't animate
    if (targetValue === startValueRef.current) {
      return;
    }

    // Cancel any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    const startValue = displayValue;
    const endValue = targetValue;
    const valueDifference = endValue - startValue;

    // If the difference is very small, just set the value immediately
    if (Math.abs(valueDifference) < 0.01) {
      setDisplayValue(endValue);
      startValueRef.current = endValue;
      return;
    }

    setIsAnimating(true);
    startTimeRef.current = performance.now();

    const animate = (currentTime: number) => {
      if (!startTimeRef.current) return;

      const elapsed = currentTime - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);

      const easedProgress = easing(progress);
      const currentValue = startValue + valueDifference * easedProgress;

      // Round to specified precision and ensure no negative numbers
      const roundedValue =
        precision > 0
          ? Math.round(currentValue * Math.pow(10, precision)) /
            Math.pow(10, precision)
          : Math.round(currentValue);

      // Ensure we never display negative numbers
      const finalValue = Math.max(0, roundedValue);
      setDisplayValue(finalValue);

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayValue(Math.max(0, endValue));
        setIsAnimating(false);
        startValueRef.current = endValue;
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [targetValue, duration, easing, precision, displayValue]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return {
    displayValue,
    isAnimating,
    targetValue,
  };
};
