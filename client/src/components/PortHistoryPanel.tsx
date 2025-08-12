import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { usePanelRef } from "../hooks/usePanelRef";

export const PortHistoryPanel = () => {
  const panelRef = usePanelRef("ports_discovered");
  return (
    <Card
      ref={panelRef}
      noElbows={false}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Discovered Ports</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        NOOP
      </CardContent>
    </Card>
  );
};
