import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { ShipOSDVisualizer } from "./ShipOSDVisualizer";

export const ShipOSDPanel = () => {
  return (
    <Card className="h-full bg-background w-[280px]" withElbows={true}>
      <CardHeader className="flex flex-row justify-between">
        <PanelTitle>Ship OSD</PanelTitle>
        <PanelTitle className="text-border">v12.1</PanelTitle>
      </CardHeader>
      <CardContent className="flex-1 flex items-center justify-center">
        <ShipOSDVisualizer
          barLineCap="square"
          participantType="bot"
          barColor="white"
          peakLineColor="--color-agent"
          peakLineThickness={3}
          peakOffset={6}
          barMaxHeight={200}
          barCount={8}
          barWidth={8}
          barOrigin="bottom"
        />
      </CardContent>
    </Card>
  );
};
