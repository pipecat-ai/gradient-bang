import useGameStore from "@/stores/game";
import type { Task } from "@/stores/taskSlice";
import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { StickToBottom } from "use-stick-to-bottom";

const ActionSummaryRow = ({ task }: { task: Task }) => {
  return <div className="text-xs normal-case">{task.summary}</div>;
};

export const ActionSummaryPanel = () => {
  const tasks = useGameStore.use.tasks();

  return (
    <Card className="flex w-full">
      <CardHeader>
        <PanelTitle>Summary</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <StickToBottom className="relative" resize="smooth" initial="smooth">
          <StickToBottom.Content className="flex flex-col gap-4">
            {tasks.map((t) => (
              <ActionSummaryRow key={t.id} task={t} />
            ))}
          </StickToBottom.Content>
        </StickToBottom>
      </CardContent>
    </Card>
  );
};
export default ActionSummaryPanel;
