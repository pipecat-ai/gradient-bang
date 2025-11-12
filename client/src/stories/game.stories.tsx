import {
  GET_KNOWN_PORT_LIST,
  GET_MAP_REGION,
  GET_MY_STATUS_MESSAGE,
} from "@/actions/dispatch";
import { CoursePlotPanel } from "@/components/CoursePlotPanel";
import { ActivityStream } from "@/components/hud/ActivityStream";
import MiniMap from "@/components/hud/MiniMap";
import { TaskOutputStream } from "@/components/hud/TaskOutputStream";
import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { Button } from "@/components/primitives/Button";
import { SettingsPanel } from "@/components/SettingsPanel";
import { TextInputControl } from "@/components/TextInputControl";
import { WarpBadge } from "@/components/WarpBadge";
import { useGameContext } from "@/hooks/useGameContext";
import { useNotificationSound } from "@/hooks/useNotificationSound";
import useGameStore from "@/stores/game";
import type { Story } from "@ladle/react";
import { Divider } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";

import { MOCK_TASK_DATA } from "./mock.stories";

export const Init: Story = () => {
  const coursePlot = useGameStore.use.course_plot?.();
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
        <TextInputControl
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
                coursePlot={coursePlot}
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
          <ActivityStream />
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

export const TaskOutput: Story = () => {
  const { sendUserTextInput } = useGameContext();
  const addTask = useGameStore.use.addTask();
  return (
    <>
      <div className="story-description">
        <TextInputControl
          onSend={(text) => {
            sendUserTextInput?.(text);
          }}
        />
        <Button
          onClick={() => {
            addTask(
              MOCK_TASK_DATA[0].summary,
              MOCK_TASK_DATA[0].type as TaskType
            );
          }}
        >
          Add Task
        </Button>
        <Button
          onClick={() => {
            addTask("Task complete", "COMPLETE");
          }}
        >
          Add Complete Task
        </Button>
        <Button
          onClick={() => {
            MOCK_TASK_DATA.forEach((task) => {
              addTask(task.summary, task.type as TaskType);
            });
          }}
        >
          Add mock
        </Button>
      </div>
      <div className="story-card h-[400px]">
        <div className="w-full h-full">
          <TaskOutputStream />
        </div>
      </div>
    </>
  );
};

TaskOutput.meta = {
  disconnectedStory: false,
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
};
