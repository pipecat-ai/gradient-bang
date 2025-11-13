import { CaptainsLogPanel } from "@/components/CaptainsLogPanel";
import { CombatTimerBadge } from "@/components/CombatTimerBadge";
import { useGameContext } from "@/hooks/useGameContext";
import useGameStore from "@/stores/game";
import type { Story } from "@ladle/react";
import {
  Button,
  Divider,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextInput,
} from "@pipecat-ai/voice-ui-kit";
import { useState } from "react";

export const Combat: Story = () => {
  const uiState = useGameStore.use.uiState();
  const activeCombatSession = useGameStore.use.activeCombatSession();
  const [activeTarget, setActiveTarget] = useState<string | undefined>(
    undefined
  );

  const { sendUserTextInput } = useGameContext();

  return (
    <>
      <div className="story-description flex flex-col gap-4">
        <Divider />
        <TextInput
          onSend={(text) => {
            sendUserTextInput?.(text);
          }}
        />
        <Divider />

        {activeCombatSession && (
          <div className="flex flex-row gap-2">
            <Select
              value={activeTarget?.toString() ?? ""}
              onValueChange={(value) => {
                setActiveTarget(value);
              }}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue
                  aria-label={activeTarget?.toString() ?? ""}
                  placeholder="Select target player"
                >
                  {activeTarget}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {activeCombatSession?.participants.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name} ({p.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => {
                  console.log("Attack");
                }}
                disabled={!activeCombatSession}
              >
                Attack
              </Button>

              <Button
                onClick={() => {
                  console.log("Brace");
                }}
                disabled={!activeCombatSession}
              >
                Brace
              </Button>
              <Button
                onClick={() => {
                  console.log("Flee");
                }}
                disabled={!activeCombatSession}
              >
                Flee
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="story-card">
        <h3 className="story-heading">UI State: {uiState}</h3>
      </div>
      <div className="story-card">
        <h3 className="story-heading">Combat Session</h3>

        <CombatTimerBadge />

        {activeCombatSession && (
          <ul>
            <li>ID: {activeCombatSession?.combat_id}</li>
            <li>Initiator: {activeCombatSession?.initiator}</li>
            <li>
              Participants:{" "}
              {activeCombatSession?.participants.map((p) => p.name).join(", ")}
            </li>
            <li>Round: {activeCombatSession?.round}</li>
            <li>Deadline: {activeCombatSession?.deadline}</li>
            <li>Current Time: {activeCombatSession?.current_time}</li>
          </ul>
        )}
      </div>
      <div className="story-card">
        <h3 className="story-heading">Combat Session</h3>
        <CaptainsLogPanel />
      </div>
    </>
  );
};

Combat.meta = {
  connectOnMount: false,
  disableAudioOutput: true,
  nableMic: false,
};
