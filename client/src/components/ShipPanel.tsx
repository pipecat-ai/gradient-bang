import {
  Card,
  CardContent,
  CardHeader,
  Divider,
  PanelTitle,
  VoiceVisualizer,
} from "@pipecat-ai/voice-ui-kit";
import { TaskStatusBadge } from "./TaskStatusBadge";

export const ShipPanel = () => {
  return (
    <Card className="h-full vkui:bg-background" noElbows={false}>
      <CardHeader className="flex flex-row justify-between">
        <PanelTitle>Ship OSD</PanelTitle>
        <PanelTitle className="vkui:text-border">v12.1</PanelTitle>
      </CardHeader>
      <CardContent className="flex-1 flex items-center justify-center">
        <VoiceVisualizer
          barLineCap="square"
          participantType="bot"
          barColor="white"
          barMaxHeight={100}
          barCount={8}
          barWidth={8}
          barOrigin="bottom"
        />
      </CardContent>
      <CardContent className="mt-auto flex flex-col gap-2">
        <Divider childrenClassName="vkui:text-xs shrink-0 w-fit opacity-30">
          Task status
        </Divider>
        <TaskStatusBadge />
      </CardContent>
    </Card>
  );
};
