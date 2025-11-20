import { useEffect, useRef, useState } from "react";

import type { AnimationPlaybackControls, Easing } from "motion/react";
import { animate, useMotionValue, useTransform } from "motion/react";

/**
 * Hook that animates a numerical value using Motion's animate function.
 * Provides smooth transitions with customizable easing and precise duration control.
 *
 * @param targetValue - The target value to animate to
 * @param options - Configuration options for the animation
 * @returns Object containing the current display value, animation state, and target value
 */
interface UseCounterOptions {
  duration?: number; // Animation duration in milliseconds
  easing?: Easing | Easing[]; // Easing function or cubic bezier array
  precision?: number; // Number of decimal places to round to
}

export const useCounter = (
  targetValue: number | undefined,
  options: UseCounterOptions = {}
) => {
  // Aggressive ease-out curve for pronounced deceleration effect
  const {
    duration = 1000,
    easing = [0.16, 1, 0.3, 1],
    precision = 0,
  } = options;

  const [displayValue, setDisplayValue] = useState<number>(targetValue ?? 0);
  const [isAnimating, setIsAnimating] = useState(false);
  const isFirstRenderRef = useRef(true);
  const animationRef = useRef<AnimationPlaybackControls | null>(null);

  // Store options in refs to avoid effect re-runs when they change
  const durationRef = useRef(duration);
  const easingRef = useRef(easing);
  const precisionRef = useRef(precision);

  // Update refs when options change
  useEffect(() => {
    durationRef.current = duration;
    easingRef.current = easing;
    precisionRef.current = precision;
  }, [duration, easing, precision]);

  // Create motion value once - stored in ref to ensure stability
  const motionValueRef = useRef(useMotionValue(targetValue ?? 0));
  const motionValue = motionValueRef.current;

  // Rounding function using ref to get current precision
  const roundValue = (value: number): number => {
    const p = precisionRef.current;
    const rounded =
      p > 0
        ? Math.round(value * Math.pow(10, p)) / Math.pow(10, p)
        : Math.round(value);
    return Math.max(0, rounded);
  };

  // Transform motion value with rounding
  const roundedRef = useRef(useTransform(motionValue, roundValue));
  const rounded = roundedRef.current;

  // Subscribe to rounded value changes
  useEffect(() => {
    const unsubscribe = rounded.on("change", (latest) => {
      setDisplayValue(latest);
    });

    return unsubscribe;
  }, [rounded]);

  // Animate to target value
  useEffect(() => {
    // Handle undefined target value
    if (targetValue === undefined) {
      if (animationRef.current) {
        animationRef.current.stop();
      }
      motionValue.set(0);
      setDisplayValue(0);
      setIsAnimating(false);
      return;
    }

    // On first render, set immediately without animation
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      const initialValue = roundValue(targetValue);
      motionValue.set(initialValue);
      setDisplayValue(initialValue);
      return;
    }

    const currentValue = motionValue.get();
    const valueDifference = Math.abs(targetValue - currentValue);

    // If the difference is very small, just set the value immediately
    if (valueDifference < 0.01) {
      const finalValue = roundValue(targetValue);
      motionValue.set(finalValue);
      setDisplayValue(finalValue);
      return;
    }

    // Cancel any existing animation
    if (animationRef.current) {
      animationRef.current.stop();
    }

    setIsAnimating(true);

    // Start animation using refs for current values
    animationRef.current = animate(motionValue, targetValue, {
      duration: durationRef.current / 1000, // Convert to seconds for Motion
      ease: easingRef.current,
      onComplete: () => {
        setIsAnimating(false);
      },
    });
  }, [targetValue, motionValue]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        animationRef.current.stop();
      }
    };
  }, []);

  return {
    displayValue,
    isAnimating,
    targetValue,
  };
};
