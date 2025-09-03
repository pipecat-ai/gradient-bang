import { Card, Divider } from "@pipecat-ai/voice-ui-kit";
import usePortStore from "../stores/port";
import { PortBadge } from "./PortBadge";
import { RetroGlitchImage } from "./RetroGlitchImage";
import { SectorBadge } from "./SectorBadge";

export const ImagePanel = () => {
  const { port, getPortImage } = usePortStore();

  const portImage = getPortImage(port?.code ?? "");

  return (
    <div className="flex flex-col gap-panel h-full w-full">
      <Card
        className="relative py-0 bg-transparent overflow-hidden h-full"
        withElbows={true}
      >
        <div className="w-image h-full">
          <RetroGlitchImage
            src={portImage}
            pixelSize={1}
            fillContainer={true}
          />
        </div>
        {/*!!port && <PortInfoPanel />*/}
      </Card>
      <Divider className="w-full py-1" variant="dotted" />
      <div className="flex flex-row gap-panel">
        <SectorBadge />
        <PortBadge />
      </div>
    </div>
  );
};
