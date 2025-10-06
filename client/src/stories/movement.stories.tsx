import { WarpBadge } from "@/components/WarpBadge";
import useGameStore from "@/stores/game";
import type { Story } from "@ladle/react";
import { Badge } from "@pipecat-ai/voice-ui-kit";

export const Sequencing: Story = () => {
  const sector = useGameStore((state) => state.sector);
  const ui = useGameStore((state) => state.ui);

  return (
    <div className="story-card">
      <h3 className="story-heading">
        UI State:{" "}
        <Badge color={ui.state === "moving" ? "active" : "secondary"}>
          {ui.state}
        </Badge>
      </h3>

      <WarpBadge />

      <h3 className="story-heading">Sector:</h3>
      {sector && (
        <ul className="story-value-list">
          {Object.entries(sector).map(([key, value]) => (
            <li key={key}>
              <span className="flex-1">{key}</span>
              <span className="flex-1">
                {typeof value === "object"
                  ? JSON.stringify(value)
                  : value.toString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

Sequencing.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  messages: [
    [
      "Hop to a random adjacent sector",
      "Pick one random adjacent sector and move to it immediately.",
    ],
    [
      "Hop to sector 0",
      "Navigate and move to sector 0 immediately, traveling along the shortest path.",
    ],
    [
      "Hop 3 adjacent sectors",
      "Hop 3 times across random adjacent sectors immediately.",
    ],
  ],
};
