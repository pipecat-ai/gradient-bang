import { Button } from "@pipecat-ai/voice-ui-kit";
import { Bug, MapPinned, RouteIcon } from "lucide-react";

export const PanelMenu = ({
  currentPanel,
  setCurrentPanel,
}: {
  currentPanel: "movement" | "port" | "debug";
  setCurrentPanel: (panel: "movement" | "port" | "debug") => void;
}) => {
  return (
    <div className="flex flex-col h-full gap-2">
      <Button
        variant={currentPanel === "movement" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("movement")}
        className={currentPanel === "movement" ? "vkui:text-agent" : ""}
      >
        <RouteIcon size={20} />
      </Button>
      <Button
        variant={currentPanel === "port" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("port")}
        className={currentPanel === "port" ? "vkui:text-agent" : ""}
      >
        <MapPinned size={20} />
      </Button>
      <Button
        variant={currentPanel === "debug" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("debug")}
        className={currentPanel === "debug" ? "vkui:text-agent" : "opacity-30"}
      >
        <Bug size={20} />
      </Button>
      <div className="flex-1 w-full h-full dotted-bg" />
    </div>
  );
};
