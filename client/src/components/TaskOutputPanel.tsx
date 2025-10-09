import useGameStore from "@/stores/game";
import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { useEffect, useRef } from "react";

const formatTimestamp = (isoString: string) => {
  return new Date(isoString).toLocaleString("en-GB", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

const TaskRow = ({
  timestamp,
  outputText,
}: {
  timestamp: string;
  outputText?: string;
}) => {
  return (
    <div className="flex flex-row gap-3 w-full text-[11px]">
      <div className="flex text-subtle font-bold">
        [{formatTimestamp(timestamp)}]
      </div>
      <div className="flex flex-row gap-2 normal-case">{outputText}</div>
    </div>
  );
};

export const TaskOutputPanel = () => {
  const bottomRef = useRef<HTMLDivElement>(null);

  const getTasks = useGameStore.use.getTasks();

  const tasks = getTasks();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tasks]);

  return (
    <Card
      withElbows={true}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Task Output</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto h-full">
        <div className="relative h-full w-full dotted-overlay-bottom">
          <div className="absolute inset-0 overflow-y-auto flex flex-col gap-3 retro-scrollbar">
            {tasks.map((task) => (
              <TaskRow
                key={task.timestamp}
                timestamp={task.timestamp}
                outputText={task.text || ""}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
