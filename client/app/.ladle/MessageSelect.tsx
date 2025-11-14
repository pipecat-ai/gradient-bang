import { useState } from "react";

import { Button } from "@/components/primitives/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/primitives/Select";
import { useGameContext } from "@/hooks/useGameContext";

export const MessageSelect = ({ messages }: { messages: string[][] }) => {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { sendUserTextInput } = useGameContext();

  return (
    <div className="flex flex-row gap-2 items-center">
      <Select
        value={selectedIndex?.toString() ?? ""}
        onValueChange={(value) => {
          const index = parseInt(value);
          if (!isNaN(index) && index >= 0 && index < messages.length) {
            setSelectedIndex(index);
          }
        }}
      >
        <SelectTrigger>
          <SelectValue
            aria-label={selectedIndex?.toString() ?? ""}
            placeholder="Select action"
          >
            {messages[selectedIndex ?? 0][0]}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {messages.map(([title], index) => (
            <SelectItem key={index} value={index.toString()}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="secondary"
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
