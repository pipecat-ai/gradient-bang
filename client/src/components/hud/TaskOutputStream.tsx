import useGameStore from "@/stores/game";

import { Card, CardContent } from "@/components/primitives/Card";
import { useEffect, useRef } from "react";

const TaskRow = ({
  outputText,
}: {
  timestamp: string;
  outputText?: string;
}) => {
  return (
    <div className="flex flex-row gap-4 w-full border-b border-white/20 pb-2 text-[10px]">
      <div className="flex flex-row gap-2 normal-case flex-1">{outputText}</div>
    </div>
  );
};

export const TaskOutputStream = () => {
  const bottomRef = useRef<HTMLDivElement>(null);

  const getTasks = useGameStore.use.getTasks();

  const tasks = getTasks();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tasks]);

  return (
    <div className="flex flex-col gap-3 w-full h-full overflow-hidden">
      <Card
        className="flex w-full h-full bg-transparent border-none"
        size="none"
      >
        <CardContent className="flex flex-col gap-2 overflow-y-auto h-full">
          <div className="relative h-full w-full">
            <div className="absolute inset-0 overflow-y-auto flex flex-col gap-2 [mask-image:linear-gradient(to_bottom,transparent_0%,black_50%,black_100%)]">
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
    </div>
  );
};
