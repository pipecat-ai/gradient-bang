import { Input } from "./primitives/Input";

import { wait } from "@/utils/animation";
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import { usePipecatClientTransportState } from "@pipecat-ai/client-react";
import { cn } from "@pipecat-ai/voice-ui-kit";
import { useState } from "react";
import { Button } from "./primitives/Button";

const THROTTLE_DELAY_MS = 2000;

export const TextInputControl = ({
  onSend,
  className,
}: {
  className?: string;
  onSend: (text: string) => void;
}) => {
  const transportState = usePipecatClientTransportState();

  const [command, setCommand] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);

  const handleSend = async (text: string) => {
    if (isDispatching) return;
    setIsDispatching(true);
    onSend(text);
    setCommand("");
    await wait(THROTTLE_DELAY_MS);
    setIsDispatching(false);
  };

  const isDisabled = false; //isDispatching || transportState !== "ready";

  return (
    <div
      className={cn(
        "relative flex-1 flex flex-row items-center min-w-2/3",
        className
      )}
    >
      <Input
        variant="default"
        placeholder="Enter command"
        value={command}
        disabled={isDisabled}
        onChange={(e) => setCommand(e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter" && command) {
            handleSend(command);
          }
        }}
        className="flex-1 pr-11"
      />
      <Button
        size="icon"
        variant={isDisabled || !command ? "ghost" : "default"}
        disabled={isDisabled}
        onClick={() => handleSend(command)}
        className={cn(
          "absolute right-0 border-l-0 outline-none",
          isDisabled || !command ? "hover:bg-transparent text-primary/50" : ""
        )}
        loader="stripes"
        isLoading={isDispatching}
      >
        <PaperPlaneRightIcon weight="bold" />
      </Button>
    </div>
  );
};
