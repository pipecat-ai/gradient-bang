import {
  Card,
  CardContent,
  Divider,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { useGameManager } from "../hooks/useGameManager";

export const PortInfoPanel = () => {
  const { game } = useGameManager();

  const portInfo = (game.sectorInfo as Record<string, unknown>)
    .port_info as Record<string, unknown>;

  console.log(portInfo);

  return (
    <Card
      className="absolute top-panel left-panel w-2/3 text-xs"
      background="grid"
      noElbows={false}
    >
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Code:</span>
            <span>{portInfo.code as string}</span>
          </div>
          <div className="flex flex-row gap-4 justify-between">
            <span className="font-extrabold">Class:</span>
            <span>{portInfo.class as string}</span>
          </div>
        </div>
        <Divider decoration="plus" />
        <PanelTitle>Trade</PanelTitle>
      </CardContent>
    </Card>
  );
};
