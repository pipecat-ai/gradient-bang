import type { Story } from "@ladle/react";
import { useCallback, useMemo, useState } from "react";

import type { MiniMapData, MiniMapRenderConfig } from "@fx/map/MiniMap";
import { MiniMap as MiniMapComponent } from "@hud/MiniMap";
import { Button } from "@pipecat-ai/voice-ui-kit";

const storyData: MiniMapData = {
  1: {
    id: 1,
    position: [0, 0],
    visited: true,
    port: "MEGA",
    region: "core_worlds",
    lanes: [
      { from: 1, to: 2, two_way: true },
      { from: 1, to: 5, two_way: true },
      { from: 1, to: 6, two_way: false },
    ],
  },
  2: {
    id: 2,
    position: [1, 0],
    visited: true,
    region: "core_worlds",
    lanes: [
      { from: 2, to: 1, two_way: true },
      { from: 2, to: 3, two_way: true },
      { from: 2, to: 7, two_way: true },
    ],
  },
  3: {
    id: 3,
    position: [1, -1],
    visited: false,
    region: "core_worlds",
    lanes: [
      { from: 3, to: 2, two_way: true },
      { from: 3, to: 4, two_way: false },
    ],
  },
  4: {
    id: 4,
    position: [0, -1],
    visited: false,
    region: "frontier",
    lanes: [{ from: 4, to: 3, two_way: false }],
  },
  5: {
    id: 5,
    position: [-1, 0],
    visited: true,
    port: "SSS",
    region: "core_worlds",
    lanes: [{ from: 5, to: 1, two_way: true }],
  },
  6: {
    id: 6,
    position: [0, 1],
    visited: false,
    region: "core_worlds",
    lanes: [{ from: 6, to: 9, two_way: true, hyperlane: true }],
  },
  7: {
    id: 7,
    position: [2, 0],
    visited: false,
    region: "core_worlds",
    lanes: [
      { from: 7, to: 2, two_way: true },
      { from: 7, to: 8, two_way: true },
    ],
  },
  8: {
    id: 8,
    position: [2, -1],
    visited: false,
    region: "frontier",
    lanes: [
      { from: 8, to: 7, two_way: true },
      { from: 8, to: 9, two_way: false, hyperlane: true },
    ],
  },
  9: {
    id: 9,
    position: [1, 1],
    visited: false,
    port: "BBS",
    region: "frontier",
    lanes: [
      { from: 9, to: 8, two_way: false, hyperlane: true },
      { from: 9, to: 6, two_way: true, hyperlane: true },
    ],
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
    grid: "rgba(255,255,255,0.06)",
    background: "rgba(0,0,0,0.85)",
  },
  grid_spacing: 50, // Distance between hex centers in pixels
  hex_size: 20, // Visual radius of each hex (leave undefined for auto: 85% of grid_spacing)
  show_grid: true,
  show_warps: true,
  show_sector_ids: true,
  show_ports: true,
  show_hyperlanes: true,
};

export const MiniMap: Story = () => {
  const [currentSectorId, setCurrentSectorId] = useState<number>(1);
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
          width={240}
          height={240}
          maxDistance={3}
        />
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5, 6].map((id) => (
            <Button size="sm" key={id} onClick={() => handleSetSector(id)}>
              Center {id}
            </Button>
          ))}
        </div>
      </div>
    </>
  );
};

MiniMap.meta = {
  connectOnMount: false,
  disableAudioOutput: true,
  enableMic: false,
};
