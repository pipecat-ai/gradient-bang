import {
  GET_KNOWN_PORT_LIST,
  GET_MAP_REGION,
  GET_MY_STATUS_MESSAGE,
} from "@/actions/dispatch";
import { CaptainsLogPanel } from "@/components/CaptainsLogPanel";
import { CoursePlotPanel } from "@/components/CoursePlotPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useGameContext } from "@/hooks/useGameContext";
import { useMessageNotificationSound } from "@/hooks/useMessageNotificationSound";
import MiniMap from "@/hud/MiniMap";
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
  const getShipHoldsRemaining = useGameStore.use.getShipHoldsRemaining();
  useMessageNotificationSound();

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
                    : value.toString()}
                </span>
              </li>
            ))}
            <li>Holds remaining: {getShipHoldsRemaining() || 0}</li>
          </ul>
        )}

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

        <div className="story-card bg-card">
          <h3 className="story-heading">Local Area Map:</h3>
          {sector && localMapData && (
            <MiniMap
              current_sector_id={sector.id}
              map_data={localMapData}
              width={440}
              height={440}
              maxDistance={2}
              config={{ debug: true }}
            />
          )}
          <Divider />
          <CoursePlotPanel />
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
