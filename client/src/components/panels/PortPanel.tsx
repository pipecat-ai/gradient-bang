import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { useEffect } from "react";
import { usePanelRef } from "../../hooks/usePanelRef";
import useImageStore from "../../stores/image";
import usePortStore from "../../stores/port";

export const PortPanel = () => {
  const { active, port } = usePortStore();
  const { setImage, getPortImage, clearImage } = useImageStore();
  const panelRef = usePanelRef("port");

  useEffect(() => {
    if (!port || !active) {
      clearImage();
      return;
    }

    // Show the port image when we're active
    setImage(getPortImage(port.code) || "");
  }, [port, active, setImage, getPortImage, clearImage]);

  if (!active) return null;

  return (
    <Card
      ref={panelRef}
      withElbows={false}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Port</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        I am the port Panel
      </CardContent>
    </Card>
  );
};
