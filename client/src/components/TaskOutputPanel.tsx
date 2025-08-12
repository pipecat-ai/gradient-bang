import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { useGameManager } from "../hooks/useGameManager";

const TaskRow = ({
  timestamp,
  outputText,
}: {
  timestamp: string;
  outputText: string;
}) => {
  return (
    <div className="flex flex-row gap-2 w-full text-xs">
      <div className="flex flex-row gap-2 vkui:text-subtle">[{timestamp}]</div>
      <div className="flex flex-row gap-2 normal-case">{outputText}</div>
    </div>
  );
};

export const TaskOutputPanel = () => {
  const { game } = useGameManager();
  return (
    <Card
      noElbows={false}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Task Output</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        {game.tasks.map((task) => (
          <TaskRow
            key={task.timestamp}
            timestamp={task.timestamp}
            outputText={task.outputText}
          />
        ))}
      </CardContent>
    </Card>
  );
};
