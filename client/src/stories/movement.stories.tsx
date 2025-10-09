import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { StarField } from "@/components/StarField";
import { WarpBadge } from "@/components/WarpBadge";
import { useGameContext } from "@/hooks/useGameContext";
import MiniMap from "@/hud/MiniMap";
import useGameStore from "@/stores/game";
import type { Story } from "@ladle/react";
import {
  Badge,
  Button,
  TextInputComponent,
  usePipecatConnectionState,
} from "@pipecat-ai/voice-ui-kit";

export const Sequencing: Story = () => {
  const sector = useGameStore((state) => state.sector);
  const localMapData = useGameStore((state) => state.local_map_data);
  const ui = useGameStore((state) => state.ui);
  const { sendUserTextInput } = useGameContext();

  return (
    <div className="flex flex-col gap-3">
      <div className="story-card">
        <TextInputComponent
          onSend={(text) => {
            sendUserTextInput?.(
              `Plan a route and move to sector ${text} immediately.`
            );
          }}
          placeholder="Enter sector to travel to"
        />
      </div>
      <div className="flex flex-row gap-3">
        <div className="story-card flex-1">
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
        <div className="bg-card min-w-[440px]">
          {sector && localMapData && (
            <MiniMap
              current_sector_id={sector?.id}
              config={{ debug: true }}
              map_data={localMapData}
              showLegend={false}
              width={440}
              height={440}
              maxDistance={3}
            />
          )}
        </div>
      </div>
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

export const MovementWithStarfield: Story = () => {
  const { isConnected } = usePipecatConnectionState();
  const sector = useGameStore((state) => state.sector);
  const localMapData = useGameStore((state) => state.local_map_data);
  const autopilot = useGameStore((state) => state.ui.autopilot);

  return (
    <div className="relative w-full h-full bg-card">
      {autopilot && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-red-500/80 p-4 shadow-xlong text-white z-[9999] animate-pulse">
          Autopilot Engaged
        </div>
      )}
      <div className="absolute z-[999] top-0 left-0">
        {sector && localMapData && (
          <MiniMap
            current_sector_id={sector?.id}
            config={{ debug: true }}
            map_data={localMapData as MapData}
            showLegend={false}
            width={440}
            height={440}
            maxDistance={3}
          />
        )}
      </div>
      {isConnected && <StarField />}
    </div>
  );
};

MovementWithStarfield.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  messages: [
    [
      "Hop to sector 0",
      "Navigate and move to sector 0 immediately. If it's not adjacent to our current sector, plot the shortest path and start moving without asking me.",
    ],
    [
      "Hop to a random adjacent sector",
      "Pick one random adjacent sector and move to it immediately.",
    ],
    [
      "Hop 3 adjacent sectors",
      "Plot a course to a randomsector 2-3 hops away from our current position and move to it immediately. Do not hop more than 3 times.",
    ],
  ],
};

export const MovementHistory: Story = () => {
  const addMovementHistory = useGameStore((state) => state.addMovementHistory);

  return (
    <div className="flex flex-col gap-3">
      <Button
        onClick={() =>
          addMovementHistory({
            from: 0,
            to: 1,
            port: true,
          })
        }
      >
        Add fake entry
      </Button>
      <MovementHistoryPanel />
    </div>
  );
};

MovementHistory.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  messages: [
    [
      "Hop to sector 0",
      "Navigate and move to sector 0 immediately. If it's not adjacent to our current sector, plot the shortest path and start moving without asking me.",
    ],
    [
      "Hop to a random adjacent sector",
      "Pick one random adjacent sector and move to it immediately.",
    ],
    [
      "Hop 3 adjacent sectors",
      "Plot a course to a randomsector 2-3 hops away from our current position and move to it immediately. Do not hop more than 3 times.",
    ],
  ],
};
