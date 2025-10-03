import { HandshakeIcon, MapPinLineIcon, PathIcon } from "@phosphor-icons/react";
import { Button } from "@pipecat-ai/voice-ui-kit";
import { Bug } from "lucide-react";
import { useLayoutEffect } from "react";
import { useUI } from "../hooks/useUI";

export type PanelMenuItem =
  | "movement_history"
  | "task_output"
  | "debug"
  | "trade_history";

const isPanelMenuItem = (value: string | null): value is PanelMenuItem => {
  return (
    value === "movement_history" ||
    value === "task_output" ||
    value === "debug" ||
    value === "trade_history"
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
        variant={currentPanel === "task_output" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("task_output")}
        className={currentPanel === "task_output" ? "text-agent" : ""}
      >
        <PathIcon size={24} />
      </Button>
      <Button
        variant={currentPanel === "movement_history" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("movement_history")}
        className={currentPanel === "movement_history" ? "text-agent" : ""}
      >
        <MapPinLineIcon size={24} weight="duotone" />
      </Button>
      <Button
        variant={currentPanel === "trade_history" ? "outline" : "ghost"}
        isIcon={true}
        size="lg"
        onClick={() => setCurrentPanel("trade_history")}
        className={currentPanel === "trade_history" ? "text-agent" : ""}
      >
        <HandshakeIcon size={24} weight="duotone" />
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
