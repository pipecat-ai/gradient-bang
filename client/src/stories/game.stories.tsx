import {
  GET_KNOWN_PORT_LIST,
  GET_MAP_REGION,
  GET_MY_STATUS_MESSAGE,
} from "@/actions/dispatch";
import { CaptainsLogPanel } from "@/components/CaptainsLogPanel";
import { CargoCapacityBadge } from "@/components/CargoCapacityBadge";
import { CoursePlotPanel } from "@/components/CoursePlotPanel";
import MiniMap from "@/components/hud/MiniMap";
import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { WarpBadge } from "@/components/WarpBadge";
import { useGameContext } from "@/hooks/useGameContext";
import { useNotificationSound } from "@/hooks/useNotificationSound";
import useGameStore from "@/stores/game";
import type { Story } from "@ladle/react";
import { Button, Divider, TextInput } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";

export const Init: Story = () => {
  const player = useGameStore((state) => state.player);
  const ship = useGameStore((state) => state.ship);
  const sector = useGameStore((state) => state.sector);
  const localMapData = useGameStore((state) => state.local_map_data);
  const messages = useGameStore.use.messages();
  useNotificationSound();

  const { dispatchEvent, sendUserTextInput } = useGameContext();

  // Filter in the component
  const directMessages = useMemo(
    () =>
      messages
        .filter((message) => message.type === "direct")
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [messages]
  );

  return (
    <>
      <div className="story-description flex flex-col gap-4">
        <p>Note: audio disabled in this story. Send text input below:</p>

        <Divider />
        <TextInput
          onSend={(text) => {
            sendUserTextInput?.(text);
          }}
        />
        <Divider />

        <Button onClick={() => dispatchEvent(GET_MY_STATUS_MESSAGE)}>
          Get My Status
        </Button>
        <Button onClick={() => dispatchEvent(GET_KNOWN_PORT_LIST)}>
          Get Known Port List
        </Button>
        <Button onClick={() => dispatchEvent(GET_MAP_REGION)}>
          Get my map
        </Button>
      </div>
      <div className="story-card">
        <h3 className="story-heading">Player:</h3>
        {player && (
          <ul className="story-value-list">
            {Object.entries(player).map(([key, value]) => (
              <li key={key}>
                <span>{key}</span> <span>{value?.toString()}</span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="story-heading">Ship:</h3>
        {ship && (
          <ul className="story-value-list">
            {Object.entries(ship).map(([key, value]) => (
              <li key={key}>
                <span className="flex-1">{key}</span>
                <span className="flex-1">
                  {typeof value === "object"
                    ? JSON.stringify(value)
                    : value?.toString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <CargoCapacityBadge />
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
                    : value?.toString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="story-card bg-card">
          <h3 className="story-heading">Local Area Map:</h3>
          <ul className="story-value-list">
            <li>Sectors visited: {player?.sectors_visited}</li>
            <li>Universe size: {player?.universe_size}</li>
          </ul>
          {sector && localMapData && (
            <div className="w-[440px] h-[520px]">
              <MiniMap
                current_sector_id={sector.id}
                map_data={localMapData}
                width={440}
                height={440}
                maxDistance={2}
                config={{ debug: true }}
              />
            </div>
          )}
          <Divider />
          <CoursePlotPanel />
          <Divider />
          <MovementHistoryPanel />
        </div>

        <div className="story-card bg-card">
          <h3 className="story-heading">Activity Log:</h3>
          <CaptainsLogPanel />
        </div>

        <div className="story-card bg-card">
          <h3 className="story-heading">Chat messages:</h3>
          {directMessages.map((message) => (
            <div key={message.id}>{JSON.stringify(message)}</div>
          ))}
        </div>
      </div>
    </>
  );
};

Init.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  messages: [["Fetch current status", "Tell me my current status."]],
};

export const Settings: Story = () => {
  return (
    <>
      <p className="story-description">
        Story shows the settings panel component. Changes are saved to the store
        when you click "Save & Close".
      </p>
      <div className="story-card" style={{ maxWidth: "600px" }}>
        <SettingsPanel />
      </div>
    </>
  );
};

Settings.meta = {
  disconnectedStory: true,
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
};
