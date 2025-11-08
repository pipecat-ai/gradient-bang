import { PanelTitle } from "@/components/PanelTitle";
import { Card, CardContent, CardHeader } from "@/components/primitives/Card";
import { ShipOSDVisualizer } from "./ShipOSDVisualizer";

export const ShipOSDPanel = () => {
  return (
    <Card className="h-full bg-background w-[230px] border-2" elbow={true}>
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
