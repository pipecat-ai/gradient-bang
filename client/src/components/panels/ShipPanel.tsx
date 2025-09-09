import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { usePanelRef } from "../../hooks/usePanelRef";

export const ShipPanel = () => {
  const panelRef = usePanelRef("ship");
  return (
    <Card
      ref={panelRef}
      withElbows={false}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Ship</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        I am the ship Panel
      </CardContent>
    </Card>
  );
};
