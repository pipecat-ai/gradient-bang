import { Button, Input } from "@pipecat-ai/voice-ui-kit";
import { ArrowRightIcon } from "lucide-react";

import {
  usePipecatClient,
  usePipecatClientTransportState,
} from "@pipecat-ai/client-react";
import { useState } from "react";

export const TextInputControl = () => {
  const client = usePipecatClient();
  const transportState = usePipecatClientTransportState();

  const [command, setCommand] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);

  const dispatchCommand = () => {
    if (!client || transportState !== "ready") return;

    setIsDispatching(true);

    // Dispatch server message here...
    client.sendClientMessage("custom-message", { text: command });

    // Wrap in timeout to avoid spamming the server
    setTimeout(() => {
      setIsDispatching(false);
      setCommand("");
    }, 1000);
  };

  return (
    <div className="flex-1 flex items-center min-w-2/3">
      <Input
        variant="ghost"
        size="lg"
        className="rounded-none normal-case placeholder:opacity-50 placeholder:uppercase text-sm"
        placeholder="Enter command"
        value={command}
        disabled={isDispatching || transportState !== "ready"}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && command.trim()) {
            dispatchCommand();
          }
        }}
      />
      <Button
        isIcon={true}
        disabled={isDispatching || transportState !== "ready"}
        onClick={dispatchCommand}
        variant="outline"
        isLoading={isDispatching}
        loader="stripes"
        size="lg"
        className="border-l-0"
      >
        <ArrowRightIcon />
      </Button>
    </div>
  );
};
