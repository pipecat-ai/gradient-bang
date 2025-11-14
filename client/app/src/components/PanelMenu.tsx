import { ChatIcon, CheckSquareOffsetIcon } from "@phosphor-icons/react";

import { Button } from "@/components/primitives/Button";

export type PanelMenuItem = "conversation" | "task_output";

export const PanelMenu = ({
  currentPanel,
  setCurrentPanel,
}: {
  currentPanel?: string;
  setCurrentPanel: (panel: string) => void;
}) => {
  return (
    <div className="flex flex-col h-full gap-2">
      <Button
        variant={currentPanel === "conversation" ? "secondary" : "ghost"}
        size="icon-lg"
        onClick={() => setCurrentPanel("conversation")}
        className={currentPanel === "conversation" ? "text-agent" : ""}
      >
        <ChatIcon size={24} weight="duotone" className="size-5" />
      </Button>
      <Button
        variant={currentPanel === "task_output" ? "secondary" : "ghost"}
        size="icon-lg"
        onClick={() => setCurrentPanel("task_output")}
        className={currentPanel === "task_output" ? "text-agent" : ""}
      >
        <CheckSquareOffsetIcon size={24} className="size-5" />
      </Button>
      <div className="flex-1 w-full h-full bg-dotted-sm bg-dotted-white/20" />
    </div>
  );
};
