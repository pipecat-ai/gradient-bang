import {
  Button,
  Divider,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pipecat-ai/voice-ui-kit";
import useGameStore from "@stores/game";
import { useState } from "react";

const debugMessages = [
  [
    "Move to random adjacent sector",
    "Tell me what sectors are adjacent, then pick one randomly and move to it.",
  ],
  ["Current status", "Tell me my current status."],
  ["Current map", "Tell me the sectors I've visited and my current map."],
];

export const Debug = () => {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { debugMode } = useGameStore.use.settings();

  if (!debugMode) return null;

  const uiState = useGameStore.use.uiState();

  return (
    <div className="absolute top-0 left-0 bg-black/80 z-20 text-xs text-white p-2 flex flex-col gap-2">
      <div className="flex flex-row gap-2 justify-between items-center">
        UI State: <span className="font-bold">{uiState}</span>
      </div>
      <Divider size="sm" />
      <Select
        value={selectedIndex?.toString() ?? ""}
        onValueChange={(value) => {
          const index = parseInt(value);
          if (!isNaN(index) && index >= 0 && index < debugMessages.length) {
            setSelectedIndex(index);
          }
        }}
      >
        <SelectTrigger size="sm">
          <SelectValue
            aria-label={selectedIndex?.toString() ?? ""}
            placeholder="Select action"
          >
            {debugMessages[selectedIndex ?? 0][0]}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {debugMessages.map(([title], index) => (
            <SelectItem key={index} value={index.toString()}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={selectedIndex === null}
        onClick={() => {
          if (selectedIndex !== null) {
            (
              window as typeof window & {
                sendUserTextInput?: (text: string) => void;
              }
            )?.sendUserTextInput?.(debugMessages[selectedIndex][1]);
            setSelectedIndex(null);
          }
        }}
      >
        Send Message
      </Button>
    </div>
  );
};
