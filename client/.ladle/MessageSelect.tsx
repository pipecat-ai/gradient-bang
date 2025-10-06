import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pipecat-ai/voice-ui-kit";
import React, { useContext, useState } from "react";
import { GameContext } from "../src/GameContext";

export const MessageSelect = ({ messages }: { messages: string[][] }) => {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { sendUserTextInput } = useContext(GameContext);

  return (
    <div className="flex flex-row gap-2">
      <Select
        value={selectedIndex?.toString() ?? ""}
        onValueChange={(value) => {
          const index = parseInt(value);
          if (!isNaN(index) && index >= 0 && index < messages.length) {
            setSelectedIndex(index);
          }
        }}
      >
        <SelectTrigger className="w-[200px]">
          <SelectValue
            aria-label={selectedIndex?.toString() ?? ""}
            placeholder="Select action"
          >
            {messages[selectedIndex ?? 0][0]}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="w-[200px]">
          {messages.map(([title], index) => (
            <SelectItem key={index} value={index.toString()}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        disabled={selectedIndex === null}
        onClick={() => {
          if (selectedIndex !== null) {
            sendUserTextInput?.(messages[selectedIndex][1]);
            setSelectedIndex(null);
          }
        }}
      >
        Dispatch
      </Button>
    </div>
  );
};
