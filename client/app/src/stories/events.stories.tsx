import { useState } from "react";

import type { Story } from "@ladle/react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@pipecat-ai/voice-ui-kit";

import { useGameContext } from "@/hooks/useGameContext";

import type { ActionType, GameAction } from "@/types/actions";

export const EventDispatcher: Story = () => {
  const { dispatchAction } = useGameContext();
  const [selectedEventType, setSelectedEventType] = useState<string | null>(
    null
  );
  const [payload, setPayload] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const handleDispatch = () => {
    setError(null);

    if (!selectedEventType) {
      setError("Please select an event type");
      return;
    }

    let parsedPayload: unknown = null;

    if (payload.trim()) {
      try {
        parsedPayload = JSON.parse(payload);
      } catch (e) {
        setError(
          "Invalid JSON: " + (e instanceof Error ? e.message : String(e))
        );
        return;
      }
    }

    // Cast needed for dynamic dispatch in dev story
    dispatchAction({
      type: selectedEventType,
      payload: parsedPayload,
    } as GameAction);
  };

  return (
    <>
      <div className="story-card">
        <Select
          value={selectedEventType ?? ""}
          onValueChange={(value) => setSelectedEventType(value)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select event type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="get-my-status">Get My Status</SelectItem>
            <SelectItem value="get-local-map">Get Local Map</SelectItem>
            <SelectItem value="get-known-ports">Get Known Ports</SelectItem>
            <SelectItem value="mute-unmute">Mute / Unmute</SelectItem>
          </SelectContent>
        </Select>
        <Textarea
          placeholder='Enter payload as JSON (e.g., {"key": "value"})'
          value={payload}
          onChange={(e) => {
            setPayload(e.target.value);
            setError(null);
          }}
        />
        {error && <div style={{ color: "red", marginTop: "8px" }}>{error}</div>}
        <Button onClick={handleDispatch}>Dispatch</Button>
      </div>
    </>
  );
};

EventDispatcher.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
};
