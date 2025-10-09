import useGameStore from "@/stores/game";
import { Card, CardContent } from "@pipecat-ai/voice-ui-kit";

export const AutoPilot = () => {
  const autopilot = useGameStore((state) => state.ui.autopilot);
  if (!autopilot) return null;

  return (
    <div className="bg-destructive/20">
      <Card
        size="xl"
        background="stripes"
        variant="destructive"
        className="shadow-long animate-pulse"
      >
        <CardContent className="flex flex-col gap-2 uppercase">
          Auto Pilot Engaged
        </CardContent>
      </Card>
    </div>
  );
};
