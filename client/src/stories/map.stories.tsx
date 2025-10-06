import type { Story } from "@ladle/react";
import { useCallback, useMemo, useState } from "react";

import type { MiniMapData, MiniMapRenderConfig } from "@fx/map/MiniMap";
import { MiniMap as MiniMapComponent } from "@hud/MiniMap";
import { Button } from "@pipecat-ai/voice-ui-kit";

const storyData: MiniMapData = {
  0: {
    id: 0,
    position: [126, 126],
    visited: true,
    port: "MEGA",
    region: "core_worlds",
    lanes: [
      { from: 0, to: 581, two_way: true },
      { from: 0, to: 657, two_way: true },
      { from: 0, to: 849, two_way: true },
    ],
  },
  126: {
    id: 126,
    position: [128, 129],
    visited: true,
    port: "",
    region: "frontier",
    lanes: [{ from: 126, to: 581, two_way: true }],
  },
  389: {
    id: 389,
    position: [123, 125],
    visited: true,
    port: "SSS",
    region: "frontier",
    lanes: [
      { from: 389, to: 0, two_way: false },
      { from: 389, to: 566, two_way: true },
      { from: 389, to: 849, two_way: true },
    ],
  },
  492: {
    id: 492,
    position: [130, 120],
    visited: false,
    region: "frontier",
    lanes: [{ from: 492, to: 1284, two_way: true }],
  },
  566: {
    id: 566,
    position: [120, 125],
    visited: true,
    port: "",
    region: "frontier",
    lanes: [
      { from: 566, to: 389, two_way: true },
      { from: 566, to: 653, two_way: true },
      { from: 566, to: 1317, two_way: false },
      { from: 566, to: 777, hyperlane: true, two_way: true },
    ],
  },
  581: {
    id: 581,
    position: [128, 126],
    visited: true,
    port: "BSB",
    region: "core_worlds",
    lanes: [
      { from: 581, to: 0, two_way: true },
      { from: 581, to: 126, two_way: true },
      { from: 581, to: 1284, two_way: true },
    ],
  },
  653: {
    id: 653,
    position: [117, 125],
    visited: false,
    region: "frontier",
    lanes: [],
  },
  657: {
    id: 657,
    position: [124, 127],
    visited: true,
    port: "",
    region: "core_worlds",
    lanes: [
      { from: 657, to: 0, two_way: true },
      { from: 657, to: 389, two_way: false },
      { from: 657, to: 849, two_way: true },
    ],
  },
  849: {
    id: 849,
    position: [124, 126],
    visited: true,
    port: "",
    region: "core_worlds",
    lanes: [
      { from: 849, to: 0, two_way: true },
      { from: 849, to: 389, two_way: true },
      { from: 849, to: 657, two_way: true },
    ],
  },
  1284: {
    id: 1284,
    position: [129, 123],
    visited: true,
    port: "",
    region: "frontier",
    lanes: [
      { from: 1284, to: 492, two_way: true },
      { from: 1284, to: 581, two_way: true },
      { from: 1284, to: 1401, two_way: true },
    ],
  },
  1317: {
    id: 1317,
    position: [117, 123],
    visited: false,
    region: "frontier",
    lanes: [],
  },
  1401: {
    id: 1401,
    position: [131, 120],
    visited: false,
    region: "frontier",
    lanes: [],
  },
};

const baseConfig: Omit<MiniMapRenderConfig, "current_sector_id"> = {
  colors: {
    empty: "rgba(0,0,0,0.35)",
    visited: "rgba(0,255,0,0.25)",
    port: "#4a90e2",
    mega_port: "#ffd700",
    lane: "rgba(120,230,160,1)",
    hyperlane: "rgba(190,160,255,1)",
    lane_one_way: "#4a90e2",
    sector_border: "rgba(200,200,200,0.7)",
    sector_border_current: "#4a90e2",
    cross_region_outline: "rgba(255,120,120,0.9)",
    sector_id_text: "#dddddd",
    grid: "rgba(255,255,255,0.3)",
    background: "#000000",
    label: "#000000",
    label_bg: "#ffffff",
    current: "#4a90e2",
    current_outline: "rgba(74,144,226,0.6",
  },
  grid_spacing: 30, // Distance between hex centers in pixels (leave undefined for auto-calculate)
  hex_size: 20, // Visual radius of each hex (leave undefined for auto: 85% of grid_spacing)
  sector_label_offset: 5,
  frame_padding: 20,
  current_sector_outer_border: 5, // Thickness of outer border for current sector
  debug: true, // Show debug bounding box
  show_grid: true,
  show_warps: true,
  show_sector_ids: true,
  show_ports: true,
  show_hyperlanes: true,
};

export const MiniMapMock: Story = () => {
  const [currentSectorId, setCurrentSectorId] = useState<number>(0);
  const [maxDistance, setMaxDistance] = useState<number>(3);
  const mergedConfig: MiniMapRenderConfig = useMemo(
    () => ({ ...baseConfig, current_sector_id: currentSectorId }),
    [currentSectorId]
  );

  const handleSetSector = useCallback(
    (id: number) => setCurrentSectorId(id),
    []
  );

  return (
    <>
      <div className="story-card space-y-3 bg-card">
        <MiniMapComponent
          config={mergedConfig}
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
