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

export const CaptainsLogPanel = () => {
  const entries = useGameStore.use.activity_log();

  return (
    <Card withElbows={false} className="flex w-full h-full bg-black">
      <CardHeader>
        <PanelTitle>Captains Log</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        {entries.map((entry: LogEntry) => (
          <LogEntry key={entry.timestamp} entry={entry} />
        ))}
      </CardContent>
    </Card>
  );
};

const LogEntry = ({ entry }: { entry: LogEntry }) => {
  const [open, setOpen] = React.useState(false);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="flex flex-col gap-2 py-3 border-b border-gray-800 last:border-b-0">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500 font-mono whitespace-nowrap">
            {entry.timestamp ? formatTimeAgoOrDate(entry.timestamp) : ""}
          </span>
          <span className="flex-1">{entry.message}</span>
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
};
