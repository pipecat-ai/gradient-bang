import { Card, Divider } from "@pipecat-ai/voice-ui-kit";
import { useGameManager } from "../hooks/useGameManager";
import { PortBadge } from "./PortBadge";
import { PortInfoPanel } from "./PortInfoPanel";
import { RetroGlitchImage } from "./RetroGlitchImage";
import { SectorBadge } from "./SectorBadge";

export const ImagePanel = () => {
  const { game } = useGameManager();

  const isAtPort = (game.sectorInfo as Record<string, unknown>).port_info;

  return (
    <div className="flex flex-col gap-panel h-full w-full">
      <Card
        className="relative py-0 bg-transparent overflow-hidden h-full"
        noElbows={false}
      >
        <div className="w-image h-full">
          <RetroGlitchImage
            src={game.image}
            pixelSize={1}
            fillContainer={true}
          />
        </div>
        {!!isAtPort && <PortInfoPanel />}
      </Card>
      <Divider className="w-full py-1" variant="dotted" />
      <div className="flex flex-row gap-panel">
        <SectorBadge />
        <PortBadge isAtPort={!!isAtPort} />
      </div>
    </div>
  );
};
