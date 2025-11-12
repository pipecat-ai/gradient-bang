import { Card, CardContent } from "@/components/primitives/Card";
import useGameStore from "@/stores/game";
import { AnimatePresence, motion } from "motion/react";

import * as React from "react";

const MAX_VISIBLE_LOG_ENTRIES = 5;
const STACK_PROCESS_WINDOW = 200;
const STACKABLE_LOG_TYPES: ReadonlySet<LogEntry["type"]> = new Set([
  "chat.direct",
]);

// Animation configuration constants
const FADE_DELAY_MS = 3000;
const LIFETIME_MS = 10_000;
const SLIDE_DISTANCE = 50;
const SLIDE_DURATION = 0.3;
const SLIDE_DELAY = 0.2;
const SLIDE_EASE = "easeOut" as const;
const FADE_OUT_DURATION = 0.5;
const FADE_OPACITY = 0.5;
const FADE_EASE = "easeInOut" as const;
const FINAL_FADEOUT_DURATION = 1.0;
const FINAL_FADEOUT_EASE = "easeOut" as const;

// Stack cooldown matches entry lifetime
const STACK_COOLDOWN_MS = LIFETIME_MS;

interface StackedLogEntry {
  key: string;
  entry: LogEntry;
  count: number;
  latestTimestampMs: number;
  signature?: string;
}

export const ActivityStream = () => {
  const entries = useGameStore.use.activity_log();
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);

  const stackedEntries = React.useMemo(() => {
    if (!entries.length) {
      return [] as StackedLogEntry[];
    }

    const startIndex =
      entries.length > STACK_PROCESS_WINDOW
        ? entries.length - STACK_PROCESS_WINDOW
        : 0;
    const recentEntries = entries.slice(startIndex);

    const aggregated: StackedLogEntry[] = [];
    const activeStacks = new Map<string, StackedLogEntry>();

    for (const entry of recentEntries) {
      const timestampMs = getEntryTimestampMs(entry);
      const safeTimestampMs = timestampMs ?? 0;
      const signature = entry.signature;
      const isStackable =
        Boolean(signature) &&
        STACKABLE_LOG_TYPES.has(entry.type) &&
        timestampMs !== undefined;

      if (!isStackable || !signature) {
        aggregated.push(
          createStackedEntry(entry, safeTimestampMs, entry.signature, false)
        );
        continue;
      }

      const existing = activeStacks.get(signature);

      if (
        existing &&
        timestampMs! - existing.latestTimestampMs <= STACK_COOLDOWN_MS
      ) {
        existing.count += 1;
        existing.entry = entry;
        existing.latestTimestampMs = timestampMs!;
        // Key remains stable for stackable entries
        activeStacks.set(signature, existing);

        const existingIndex = aggregated.findIndex((item) => item === existing);
        if (existingIndex !== -1) {
          aggregated.splice(existingIndex, 1);
        }
        aggregated.push(existing);
        continue;
      }

      const stackedEntry = createStackedEntry(
        entry,
        timestampMs!,
        signature,
        true
      );
      activeStacks.set(signature, stackedEntry);
      aggregated.push(stackedEntry);
    }

    return aggregated.slice(-MAX_VISIBLE_LOG_ENTRIES);
  }, [entries]);

  // Filter out expired entries before rendering
  // Recalculates on every render to catch expiration times
  const now = Date.now();
  const visibleEntries = stackedEntries.filter((item) => {
    const expirationTime = item.latestTimestampMs + STACK_COOLDOWN_MS;
    return now < expirationTime;
  });

  return (
    <Card
      className="relative z-(--z-hud) flex h-full w-full border-none overflow-hidden bg-transparent py-ui-md"
      size="none"
    >
      <CardContent className="flex flex-col gap-3 overflow-y-auto flex-1 justify-center">
        <AnimatePresence mode="popLayout">
          {visibleEntries.map((item) => (
            <LogEntryRow
              key={item.key}
              entry={item.entry}
              count={item.count}
              onExpire={forceUpdate}
            />
          ))}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
};

const formatMessage = (message: string) => {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = /\[([^\]]+)\]/g;
  let match;

  while ((match = regex.exec(message)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(message.substring(lastIndex, match.index));
    }
    // Add the bracketed text as a span
    parts.push(<span key={match.index}>{match[1]}</span>);
    lastIndex = regex.lastIndex;
  }

  // Add any remaining text
  if (lastIndex < message.length) {
    parts.push(message.substring(lastIndex));
  }

  return parts.length > 0 ? parts : message;
};

const LogEntryRow = React.memo(
  ({
    entry,
    count,
    onExpire,
  }: {
    entry: LogEntry;
    count: number;
    onExpire: () => void;
  }) => {
    const prevCountRef = React.useRef(count);
    const isInitialMountRef = React.useRef(true);
    const [opacityKey, setOpacityKey] = React.useState(0);

    // Track count changes for opacity reset
    React.useEffect(() => {
      if (!isInitialMountRef.current && prevCountRef.current !== count) {
        prevCountRef.current = count;
        // Trigger opacity re-animation by changing key
        setOpacityKey((k) => k + 1);
      }
    }, [count]);

    // Single timer: triggers re-render when entry should expire
    React.useEffect(() => {
      const lifetimeTimer = setTimeout(() => {
        onExpire();
      }, STACK_COOLDOWN_MS);

      return () => clearTimeout(lifetimeTimer);
    }, [count, onExpire]);

    // Calculate timing values for opacity keyframes
    const totalOpacityDuration =
      SLIDE_DELAY + (FADE_DELAY_MS + FADE_OUT_DURATION * 1000) / 1000;
    const opacityTimes = [
      0,
      SLIDE_DELAY / totalOpacityDuration,
      (SLIDE_DELAY + FADE_DELAY_MS / 1000) / totalOpacityDuration,
      1,
    ];

    // Determine animation based on initial mount
    const animate = isInitialMountRef.current
      ? {
          x: 0,
          opacity: [0, 1, 1, FADE_OPACITY],
        }
      : {
          opacity: [1, 1, FADE_OPACITY],
        };

    const transition = isInitialMountRef.current
      ? {
          x: {
            duration: SLIDE_DURATION,
            delay: SLIDE_DELAY,
            ease: SLIDE_EASE,
          },
          opacity: {
            duration: totalOpacityDuration,
            times: opacityTimes,
            ease: FADE_EASE,
          },
          layout: { duration: 0.3, ease: "easeInOut" as const },
        }
      : {
          opacity: {
            duration: (FADE_DELAY_MS + FADE_OUT_DURATION * 1000) / 1000,
            times: [
              0,
              FADE_DELAY_MS / (FADE_DELAY_MS + FADE_OUT_DURATION * 1000),
              1,
            ],
            ease: FADE_EASE,
          },
          layout: { duration: 0.3, ease: "easeInOut" as const },
        };

    // Mark as no longer initial mount after first render
    React.useEffect(() => {
      isInitialMountRef.current = false;
    }, []);

    return (
      <motion.div
        key={opacityKey}
        className="flex flex-col gap-2"
        layout
        initial={
          isInitialMountRef.current
            ? { x: -SLIDE_DISTANCE, opacity: 0 }
            : { opacity: 1 }
        }
        animate={animate}
        transition={transition}
        exit={{
          opacity: 0,
          transition: {
            duration: FINAL_FADEOUT_DURATION,
            ease: FINAL_FADEOUT_EASE,
          },
        }}
      >
        <div className="flex items-center max-w-max gap-2">
          <div className="bg-terminal w-4 h-px" />
          <span className="bg-background/40 px-2 py-1 flex-1 uppercase text-xs font-extrabold [&_span]:bg-white [&_span]:text-black [&_span]:px-1">
            {formatMessage(entry.message)}
          </span>
          {count > 1 ? <StackCountBubble count={count} /> : null}
        </div>
      </motion.div>
    );
  },
  (prev, next) => prev.entry === next.entry && prev.count === next.count
);

const StackCountBubble = ({ count }: { count: number }) => (
  <span className="inline-flex h-full min-w-7 items-center justify-center bg-fuel/20 px-2 py-0.5 text-xs font-semibold text-fuel">
    {count}
  </span>
);

function getEntryTimestampMs(entry: LogEntry) {
  if (typeof entry.timestamp_client === "number") {
    return entry.timestamp_client;
  }

  if (entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function createStackedEntry(
  entry: LogEntry,
  timestampMs: number,
  signature?: string,
  isStackable: boolean = false
): StackedLogEntry {
  return {
    key: buildStackKey(
      entry,
      signature ?? entry.type,
      timestampMs,
      isStackable
    ),
    entry,
    count: 1,
    latestTimestampMs: timestampMs,
    signature,
  };
}

function buildStackKey(
  entry: LogEntry,
  identifier: string,
  timestampMs: number,
  isStackable: boolean = false
) {
  // Stackable entries use signature-only key for stability
  if (isStackable) {
    return `stack:${identifier}`;
  }

  // Non-stackable entries use timestamp for uniqueness
  const fallback = entry.timestamp ?? entry.message;
  return `${identifier}:${timestampMs || 0}:${fallback}`;
}
