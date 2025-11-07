import useGameStore from "@/stores/game";

import { PanelTitle } from "@/components/PanelTitle";
import { Card, CardContent, CardHeader } from "@/components/primitives/Card";
import { Separator } from "@/components/primitives/Separator";
import { useEffect, useRef } from "react";
import { TaskStatusBadge } from "./TaskStatusBadge";

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
    <div className="flex flex-row gap-4 w-full text-xs border-b border-border/50 pb-2">
      <div className="flex text-subtle font-bold w-[120px] opacity-80">
        [{formatTimestamp(timestamp)}]
      </div>
      <div className="flex flex-row gap-2 normal-case flex-1">{outputText}</div>
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
    <div className="flex flex-col gap-3 w-full h-full">
      <Card
        elbow={true}
        className="flex w-full h-full bg-card/50 backdrop-blur-sm border border-border"
        size="sm"
      >
        <CardHeader>
          <PanelTitle>Task Output</PanelTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 overflow-y-auto h-full">
          <div className="relative h-full w-full">
            <div className="absolute inset-0 overflow-y-auto flex flex-col gap-3 retro-scrollbar">
              {tasks.map((task) => (
                <TaskRow
                  key={task.timestamp}
                  timestamp={task.timestamp}
                  outputText={task.summary || ""}
                />
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        </CardContent>
      </Card>
      <Separator variant="dotted" className="w-full text-white/20 h-[12px]" />
      <TaskStatusBadge />
    </div>
  );
};
