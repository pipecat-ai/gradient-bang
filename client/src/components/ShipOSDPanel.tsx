import {
  Card,
  CardContent,
  CardHeader,
  Divider,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { ShipOSDVisualizer } from "./ShipOSDVisualizer";
import { TaskStatusBadge } from "./TaskStatusBadge";

export const ShipOSDPanel = () => {
  return (
    <Card className="h-full bg-background" withElbows={true}>
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
          barMaxHeight={100}
          barCount={8}
          barWidth={8}
          barOrigin="bottom"
        />
      </CardContent>
      <CardContent className="mt-auto flex flex-col gap-2">
        <Divider childrenClassName="text-xs shrink-0 w-fit opacity-30">
          Task status
        </Divider>
        <TaskStatusBadge />
      </CardContent>
    </Card>
  );
};
