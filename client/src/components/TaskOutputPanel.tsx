import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { usePanelRef } from "../hooks/usePanelRef";
import useTaskStore from "../stores/tasks";

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
    <div className="flex flex-row gap-2 w-full text-xs">
      <div className="flex flex-row gap-2 text-subtle">
        [{formatTimestamp(timestamp)}]
      </div>
      <div className="flex flex-row gap-2 normal-case">{outputText}</div>
    </div>
  );
};

export const TaskOutputPanel = () => {
  const panelRef = usePanelRef("task_output");
  const { getTasks } = useTaskStore();

  const tasks = getTasks();
  console.log(tasks);

  return (
    <Card
      ref={panelRef}
      withElbows={true}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Task Output</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto h-full">
        <div className="relative h-full w-full dotted-overlay-bottom">
          <div className="absolute inset-0 overflow-y-auto flex flex-col gap-4 retro-scrollbar">
            {tasks.map((task) => (
              <TaskRow
                key={task.timestamp}
                timestamp={task.timestamp}
                outputText={task.text || ""}
              />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
