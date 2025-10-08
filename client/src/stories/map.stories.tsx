import type { Story } from "@ladle/react";
import { useCallback, useState } from "react";

import {
  MiniMap as MiniMapComponent,
  type MiniMapConfigOverrides,
} from "@hud/MiniMap";
import { Button } from "@pipecat-ai/voice-ui-kit";

const storyData: MapData = [
  {
    id: 0,
    position: [126, 126],
    visited: true,
    port: "MEGA",
    region: "core_worlds",
    lanes: [
      { to: 581, two_way: true },
      { to: 657, two_way: true },
      { to: 849, two_way: true },
    ],
  },
  {
    id: 126,
    position: [128, 129],
    visited: true,
    port: "",
    region: "frontier",
    lanes: [{ to: 581, two_way: true }],
  },
  {
    id: 389,
    position: [123, 125],
    visited: true,
    port: "SSS",
    region: "frontier",
    lanes: [
      { to: 0, two_way: false },
      { to: 566, two_way: true },
      { to: 849, two_way: true },
    ],
  },
  {
    id: 492,
    position: [130, 120],
    visited: false,
    region: "frontier",
    lanes: [{ to: 1284, two_way: true }],
  },
  {
    id: 566,
    position: [120, 125],
    visited: true,
    port: "",
    region: "frontier",
    lanes: [
      { to: 389, two_way: true },
      { to: 653, two_way: true },
      { to: 1317, two_way: false },
      { to: 777, hyperlane: true, two_way: true },
    ],
  },
  {
    id: 581,
    position: [128, 126],
    visited: true,
    port: "BSB",
    region: "core_worlds",
    lanes: [
      { to: 0, two_way: true },
      { to: 126, two_way: true },
      { to: 1284, two_way: true },
    ],
  },
  {
    id: 653,
    position: [117, 125],
    visited: false,
    region: "frontier",
    lanes: [],
  },
  {
    id: 657,
    position: [124, 127],
    visited: true,
    port: "",
    region: "core_worlds",
    lanes: [
      { to: 0, two_way: true },
      { to: 389, two_way: false },
      { to: 849, two_way: true },
    ],
  },
  {
    id: 849,
    position: [124, 126],
    visited: true,
    port: "",
    region: "core_worlds",
    lanes: [
      { to: 0, two_way: true },
      { to: 389, two_way: true },
      { to: 657, two_way: true },
    ],
  },
  {
    id: 1284,
    position: [129, 123],
    visited: true,
    port: "",
    region: "frontier",
    lanes: [
      { to: 492, two_way: true },
      { to: 581, two_way: true },
      { to: 1401, two_way: true },
    ],
  },
  {
    id: 1317,
    position: [117, 123],
    visited: false,
    region: "frontier",
    lanes: [],
  },
  {
    id: 1401,
    position: [131, 120],
    visited: false,
    region: "frontier",
    lanes: [],
  },
];

export const MiniMapMock: Story = () => {
  const [currentSectorId, setCurrentSectorId] = useState<number>(0);
  const [maxDistance, setMaxDistance] = useState<number>(3);
  const [bypassAnimation, setBypassAnimation] = useState<boolean>(false);

  const handleSetSector = useCallback(
    (id: number) => setCurrentSectorId(id),
    []
  );

  const configOverrides: MiniMapConfigOverrides = {
    bypass_animation: bypassAnimation,
  };

  return (
    <>
      <div className="story-card space-y-3 bg-card">
        <MiniMapComponent
          current_sector_id={currentSectorId}
          config={configOverrides}
          map_data={storyData}
          width={440}
          height={440}
          maxDistance={maxDistance}
        />
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label htmlFor="distance-slider" className="text-sm font-medium">
              Max Distance: {maxDistance}
            </label>
            <input
              id="distance-slider"
              type="range"
              min="1"
              max="7"
              value={maxDistance}
              onChange={(e) => setMaxDistance(Number(e.target.value))}
              className="flex-1"
            />
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="animation-toggle" className="text-sm font-medium">
              <input
                id="animation-toggle"
                type="checkbox"
                checked={bypassAnimation}
                onChange={(e) => setBypassAnimation(e.target.checked)}
                className="mr-2"
              />
              Bypass Animation
            </label>
          </div>
          <div className="flex gap-2 flex-wrap">
            {[0, 581, 389, 566, 849, 1284].map((id) => (
              <Button size="sm" key={id} onClick={() => handleSetSector(id)}>
                Center {id}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};

MiniMapMock.meta = {
  connectOnMount: false,
  disableAudioOutput: true,
  enableMic: false,
  disconnectedStory: true,
};
