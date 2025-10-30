import useGameStore from "@/stores/game";
import { formatTimeAgoOrDate } from "@/utils/date";
import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";

const MAX_VISIBLE_LOG_ENTRIES = 100;
const STACK_COOLDOWN_MS = 60_000;
const STACK_PROCESS_WINDOW = 200;
const STACKABLE_LOG_TYPES: ReadonlySet<LogEntry["type"]> = new Set([
  "chat.direct",
]);

interface StackedLogEntry {
  key: string;
  entry: LogEntry;
  count: number;
  latestTimestampMs: number;
  signature?: string;
}

export const CaptainsLogPanel = () => {
  const entries = useGameStore.use.activity_log();

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
          createStackedEntry(entry, safeTimestampMs, entry.signature)
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
        existing.key = buildStackKey(entry, signature, timestampMs!);
        activeStacks.set(signature, existing);

        const existingIndex = aggregated.findIndex((item) => item === existing);
        if (existingIndex !== -1) {
          aggregated.splice(existingIndex, 1);
        }
        aggregated.push(existing);
        continue;
      }

      const stackedEntry = createStackedEntry(entry, timestampMs!, signature);
      activeStacks.set(signature, stackedEntry);
      aggregated.push(stackedEntry);
    }

    return aggregated.slice(-MAX_VISIBLE_LOG_ENTRIES);
  }, [entries]);

  return (
    <Card withElbows={false} className="flex w-full h-full bg-black">
      <CardHeader>
        <PanelTitle>Captains Log</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        {stackedEntries.map((item) => (
          <LogEntryRow key={item.key} entry={item.entry} count={item.count} />
        ))}
      </CardContent>
    </Card>
  );
};

const LogEntryRow = React.memo(
  ({ entry, count }: { entry: LogEntry; count: number }) => {
    const [open, setOpen] = React.useState(false);

    return (
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-2 py-3 border-b border-gray-800 last:border-b-0">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500 font-mono whitespace-nowrap">
              {entry.timestamp ? formatTimeAgoOrDate(entry.timestamp) : ""}
            </span>
            <span className="flex-1">{entry.message}</span>
            {count > 1 ? <StackCountBubble count={count} /> : null}
          </div>
          <div className="flex items-center gap-1">
            <Collapsible.Trigger asChild>
              <button
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                aria-label="Toggle details"
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{open ? "Hide" : "Show"} details</span>
              </button>
            </Collapsible.Trigger>
          </div>
          <Collapsible.Content className="overflow-hidden">
            <pre className="text-xs bg-gray-900 p-2 rounded overflow-x-auto">
              {JSON.stringify(entry, null, 2)}
            </pre>
          </Collapsible.Content>
        </div>
      </Collapsible.Root>
    );
  },
  (prev, next) => prev.count === next.count && prev.entry === next.entry
);

const StackCountBubble = ({ count }: { count: number }) => (
  <span className="inline-flex min-w-[1.75rem] items-center justify-center rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-semibold text-blue-300">
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
  signature?: string
): StackedLogEntry {
  return {
    key: buildStackKey(entry, signature ?? entry.type, timestampMs),
    entry,
    count: 1,
    latestTimestampMs: timestampMs,
    signature,
  };
}

function buildStackKey(
  entry: LogEntry,
  identifier: string,
  timestampMs: number
) {
  const fallback = entry.timestamp ?? entry.message;
  return `${identifier}:${timestampMs || 0}:${fallback}`;
}
