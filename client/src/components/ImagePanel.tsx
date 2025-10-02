import { PortBadge } from "@/components/PortBadge";
import { SectorBadge } from "@/components/SectorBadge";
import useGameStore from "@/stores/game";
import { Card, Divider } from "@pipecat-ai/voice-ui-kit";
import { RetroGlitchImage } from "../fx/RetroGlitchImage";

export const ImagePanel = () => {
  const { osdImage } = useGameStore.use.visualElements();

  return (
    <div className="flex flex-col gap-panel h-full w-full">
      <Card
        className="relative py-0 bg-transparent overflow-hidden h-full"
        withElbows={true}
      >
        <div className="w-image h-full">
          <RetroGlitchImage
            terminalColor="#b4ff49"
            imageFit="cover"
            src={osdImage || ""}
            pixelSize={1}
            fillContainer={true}
          />
        </div>
      </Card>
      <Divider className="w-full py-1.5" variant="dotted" />
      <div className="flex flex-row gap-panel">
        <SectorBadge />
        <PortBadge />
      </div>
    </div>
  );
};
