import React, {
  type ComponentPropsWithoutRef,
  type ElementType,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

interface ScrambleTextProps<T extends ElementType = "span"> {
  /** The text content to be scrambled */
  children: string;
  /** The HTML element type to render as (defaults to "span") */
  as?: T;
  /** Characters used for the scramble effect (defaults to block characters) */
  chars?: string;
  /** Whether to play the scramble animation on mount (defaults to true) */
  playOnMount?: boolean;
  /** When true, scrambles the text out to random characters/empty */
  scrambledOut?: boolean;
  /** Callback function triggered when animation completes */
  onComplete?: () => void;
  /** CSS class name to apply to the component */
  className?: string;
  /** Inline styles to apply to the component */
  style?: React.CSSProperties;
}

/** Imperative methods exposed via ref */
export interface ScrambleTextRef {
  /** Scramble in the current text */
  scrambleIn: () => Promise<void>;
  /**
   * Scramble out to random characters
   * @param duration - Optional duration in milliseconds to keep scrambling. If provided,
   *                   the text will continuously show random characters for this duration.
   */
  scrambleOut: (duration?: number) => Promise<void>;
  /** Get the current text state */
  getText: () => string;
}

interface QueueItem {
  from: string;
  to: string;
  start: number; // milliseconds
  end: number; // milliseconds
  char?: string;
}

/**
 * A production-ready React component that applies a scramble animation effect to text.
 * Uses refs internally to avoid re-renders during animation.
 *
 * @example
 * // Basic usage
 * <ScrambleText>Hello World</ScrambleText>
 *
 * // With custom element
 * <ScrambleText as="h1" className="title">My Title</ScrambleText>
 *
 * // Declarative scramble out
 * <ScrambleText scrambledOut={isHidden}>Toggle Me</ScrambleText>
 *
 * // Imperative control via ref
 * const ref = useRef<ScrambleTextRef>(null);
 * ref.current?.scrambleOut();
 * <ScrambleText ref={ref}>Controlled Text</ScrambleText>
 */
function ScrambleTextComponent<T extends ElementType = "span">(
  {
    children,
    as,
    chars = "█▓▒░|:.",
    playOnMount = true,
    scrambledOut = false,
    onComplete,
    className,
    style,
    ...props
  }: ScrambleTextProps<T> &
    Omit<ComponentPropsWithoutRef<T>, keyof ScrambleTextProps<T>>,
  ref: React.Ref<ScrambleTextRef>
) {
  const elementRef = useRef<HTMLElement>(null);
  const scrambleStateRef = useRef<{
    queue: QueueItem[];
    startTime: number; // performance.now() timestamp
    frameRequest: number | null;
    resolve: (() => void) | null;
    chars: string;
    currentText: string;
    targetText: string;
    continuousScrambleTimer: number | null;
  }>({
    queue: [],
    startTime: 0,
    frameRequest: null,
    resolve: null,
    chars,
    currentText: "",
    targetText: children,
    continuousScrambleTimer: null,
  });

  // Store latest values in refs to avoid stale closures
  const charsRef = useRef(chars);
  const onCompleteRef = useRef(onComplete);
  const childrenRef = useRef(children);

  useEffect(() => {
    charsRef.current = chars;
  }, [chars]);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    childrenRef.current = children;
    scrambleStateRef.current.targetText = children;
  }, [children]);

  const randomChar = useCallback(() => {
    const chars = charsRef.current;
    return chars[Math.floor(Math.random() * chars.length)];
  }, []);

  const update = useCallback(() => {
    const el = elementRef.current;
    const state = scrambleStateRef.current;

    if (!el) return;

    const elapsed = performance.now() - state.startTime;
    let output = "";
    let complete = 0;

    for (let i = 0; i < state.queue.length; i++) {
      const item = state.queue[i];
      const { from, to, start, end } = item;

      if (elapsed >= end) {
        complete++;
        output += to;
      } else if (elapsed >= start) {
        if (!item.char || Math.random() < 0.28) {
          item.char = randomChar();
        }
        output += `<span class="scramble-char">${item.char}</span>`;
      } else {
        output += from;
      }
    }

    el.innerHTML = output;

    if (complete === state.queue.length) {
      if (state.resolve) {
        state.resolve();
        state.resolve = null;
      }
      if (onCompleteRef.current) {
        onCompleteRef.current();
      }
    } else {
      state.frameRequest = requestAnimationFrame(update);
    }
  }, [randomChar]);

  const scramble = useCallback(
    (newText: string): Promise<void> => {
      const el = elementRef.current;
      const state = scrambleStateRef.current;

      if (!el) return Promise.resolve();

      const oldText = state.currentText;
      const length = Math.max(oldText.length, newText.length);

      const promise = new Promise<void>((resolve) => {
        state.resolve = resolve;
      });

      state.queue = [];
      state.currentText = newText;

      // Timing parameters (milliseconds) for consistent behavior across frame rates
      const minDelay = 0; // Minimum delay before a character starts scrambling
      const maxDelay = 400; // Maximum delay before a character starts scrambling
      const minDuration = 200; // Minimum time a character spends scrambling
      const maxDuration = 600; // Maximum time a character spends scrambling

      for (let i = 0; i < length; i++) {
        const from = oldText[i] || "";
        const to = newText[i] || "";
        const start =
          Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
        const duration =
          Math.floor(Math.random() * (maxDuration - minDuration + 1)) +
          minDuration;
        const end = start + duration;

        state.queue.push({ from, to, start, end });
      }

      if (state.frameRequest !== null) {
        cancelAnimationFrame(state.frameRequest);
      }

      state.startTime = performance.now();
      update();

      return promise;
    },
    [update]
  );

  // Generate scrambled text (all random chars)
  const generateScrambledText = useCallback(
    (length: number): string => {
      return Array.from({ length }, () => randomChar()).join("");
    },
    [randomChar]
  );

  // Continuously scramble for a duration
  const continuousScramble = useCallback(
    (duration: number): Promise<void> => {
      const el = elementRef.current;
      const state = scrambleStateRef.current;

      if (!el) return Promise.resolve();

      // Clear any existing animations
      if (state.frameRequest !== null) {
        cancelAnimationFrame(state.frameRequest);
        state.frameRequest = null;
      }
      if (state.continuousScrambleTimer !== null) {
        clearTimeout(state.continuousScrambleTimer);
        state.continuousScrambleTimer = null;
      }

      const targetLength = childrenRef.current.length;
      const startTime = Date.now();

      return new Promise<void>((resolve) => {
        const updateScramble = () => {
          const elapsed = Date.now() - startTime;

          if (elapsed >= duration) {
            // Duration complete, resolve
            state.currentText = generateScrambledText(targetLength);
            el.innerHTML = state.currentText
              .split("")
              .map((char) => `<span class="scramble-char">${char}</span>`)
              .join("");
            resolve();
            return;
          }

          // Generate new scrambled text
          const scrambled = generateScrambledText(targetLength);
          state.currentText = scrambled;
          el.innerHTML = scrambled
            .split("")
            .map((char) => `<span class="scramble-char">${char}</span>`)
            .join("");

          // Continue scrambling every 50ms for smooth effect
          state.continuousScrambleTimer = window.setTimeout(updateScramble, 50);
        };

        updateScramble();
      });
    },
    [generateScrambledText]
  );

  // Expose imperative methods via ref
  useImperativeHandle(
    ref,
    () => ({
      scrambleIn: async () => {
        const state = scrambleStateRef.current;
        // Stop any continuous scrambling
        if (state.continuousScrambleTimer !== null) {
          clearTimeout(state.continuousScrambleTimer);
          state.continuousScrambleTimer = null;
        }
        const targetText = childrenRef.current;
        await scramble(targetText);
      },
      scrambleOut: async (duration?: number) => {
        if (duration && duration > 0) {
          // Continuous scrambling mode
          await continuousScramble(duration);
        } else {
          // Single scramble animation
          const currentLength = childrenRef.current.length;
          const scrambled = generateScrambledText(currentLength);
          await scramble(scrambled);
        }
      },
      getText: () => {
        return scrambleStateRef.current.currentText;
      },
    }),
    [scramble, generateScrambledText, continuousScramble]
  );

  // Initial scramble on mount
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    if (playOnMount && !scrambledOut) {
      scramble(children);
    } else if (scrambledOut) {
      const scrambled = generateScrambledText(children.length);
      el.textContent = scrambled;
      scrambleStateRef.current.currentText = scrambled;
    } else {
      el.textContent = children;
      scrambleStateRef.current.currentText = children;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle scrambledOut prop changes (declarative API)
  useEffect(() => {
    if (scrambledOut) {
      const currentLength = childrenRef.current.length;
      const scrambled = generateScrambledText(currentLength);
      scramble(scrambled);
    } else {
      const targetText = childrenRef.current;
      if (scrambleStateRef.current.currentText !== targetText) {
        scramble(targetText);
      }
    }
  }, [scrambledOut, scramble, generateScrambledText]);

  // Scramble when text changes (only if not scrambled out)
  useEffect(() => {
    if (
      !scrambledOut &&
      scrambleStateRef.current.currentText &&
      scrambleStateRef.current.currentText !== children
    ) {
      scramble(children);
    }
  }, [children, scramble, scrambledOut]);

  // Cleanup on unmount
  useEffect(() => {
    const state = scrambleStateRef.current;
    return () => {
      if (state.frameRequest !== null) {
        cancelAnimationFrame(state.frameRequest);
      }
      if (state.continuousScrambleTimer !== null) {
        clearTimeout(state.continuousScrambleTimer);
      }
    };
  }, []);

  const Component = (as || "span") as ElementType;

  return (
    <Component
      ref={elementRef}
      className={className}
      style={style}
      {...props}
    />
  );
}

// Type helper for the forwarded ref component
type ScrambleTextComponentType = <T extends ElementType = "span">(
  props: ScrambleTextProps<T> &
    Omit<ComponentPropsWithoutRef<T>, keyof ScrambleTextProps<T>> & {
      ref?: React.Ref<ScrambleTextRef>;
    }
) => React.ReactElement | null;

// Wrap with forwardRef and cast to preserve generic signature
// Using unknown for type safety while maintaining flexibility
const ScrambleTextWithRef = forwardRef(
  ScrambleTextComponent as unknown as React.ForwardRefRenderFunction<
    ScrambleTextRef,
    ScrambleTextProps<ElementType>
  >
) as unknown as ScrambleTextComponentType;

// Memoize the component to prevent unnecessary re-renders
export const ScrambleText = memo(
  ScrambleTextWithRef
) as unknown as ScrambleTextComponentType;

// Add display name for debugging
Object.defineProperty(ScrambleText, "displayName", {
  value: "ScrambleText",
  writable: false,
});

// Export default for convenience
export default ScrambleText;
