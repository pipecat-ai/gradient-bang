import { Button } from "@pipecat-ai/voice-ui-kit";
import { Bug, MapPinned, RouteIcon } from "lucide-react";
import { useLayoutEffect } from "react";
import { useUI } from "../hooks/useUI";

export type PanelMenuItem = "movement_history" | "ports_discovered" | "debug";

const isPanelMenuItem = (value: string | null): value is PanelMenuItem => {
  return (
    value === "movement_history" ||
    value === "ports_discovered" ||
    value === "debug"
  );
};

export const PanelMenu = ({
  currentPanel,
  setCurrentPanel,
}: {
  currentPanel: PanelMenuItem;
  setCurrentPanel: (panel: PanelMenuItem) => void;
}) => {
  const { ui } = useUI();

  useLayoutEffect(() => {
    if (ui.highlightedPanel && isPanelMenuItem(ui.highlightedPanel)) {
      setCurrentPanel(ui.highlightedPanel);
    }
  }, [ui.highlightedPanel, setCurrentPanel]);

  return (
    <div className="flex flex-col h-full gap-2">
      <Button
        variant={currentPanel === "movement_history" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("movement_history")}
        className={currentPanel === "movement_history" ? "text-agent" : ""}
      >
        <RouteIcon size={20} />
      </Button>
      <Button
        variant={currentPanel === "ports_discovered" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("ports_discovered")}
        className={currentPanel === "ports_discovered" ? "text-agent" : ""}
      >
        <MapPinned size={20} />
      </Button>
      <Button
        variant={currentPanel === "debug" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("debug")}
        className={currentPanel === "debug" ? "text-agent" : "opacity-30"}
      >
        <Bug size={20} />
      </Button>
      <div className="flex-1 w-full h-full dotted-bg" />
    </div>
  );
};
