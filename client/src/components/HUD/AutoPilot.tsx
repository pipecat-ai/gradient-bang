import { Card, CardContent } from "@pipecat-ai/voice-ui-kit";
import useTaskStore from "../../stores/tasks";

export const AutoPilot = () => {
  const { active, status } = useTaskStore();

  if (!active || status === "completed") return null;

  return (
    <Card
      size="xl"
      background="stripes"
      variant="destructive"
      className="shadow-long animate-pulse"
    >
      <CardContent className="flex flex-col gap-2">
        Auto Pilot Engaged
      </CardContent>
    </Card>
  );
};
