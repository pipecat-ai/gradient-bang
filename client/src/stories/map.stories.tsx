import type { Story } from "@ladle/react";
import { useCallback, useEffect, useState } from "react";

import { DiscoveredPortsPanel } from "@/components/DiscoveredPortsPanel";
import { Button } from "@/components/primitives/Button";
import { Divider } from "@/components/primitives/Divider";
import { MiniMap as MiniMapComponent, type MiniMapConfig } from "@hud/MiniMap";

import { GET_MAP_REGION } from "@/actions/dispatch";
import { useGameContext } from "@/hooks/useGameContext";
import useGameStore from "@/stores/game";
import { MapScreen } from "@screens/MapScreen";

export const MapPanelStory: Story = () => {
  const { dispatchEvent, sendUserTextInput } = useGameContext();
  const [maxHops, setMaxHops] = useState(50);
  const [fromSectorId, setFromSectorId] = useState(0);
  const [targetSectorId, setTargetSectorId] = useState<number>(0);
  const sector = useGameStore.use.sector?.();
  const clearCoursePlot = useGameStore.use.clearCoursePlot?.();

  useEffect(() => {
    setFromSectorId(sector?.id ?? 0);
  }, [sector]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        {sector && (
          <div className="flex flex-row w-full gap-3">
            From:{" "}
            <input
              type="number"
              defaultValue={sector?.id ?? 0}
              onChange={(e) => setFromSectorId(Number(e.target.value))}
            />
            <input
              type="range"
              min={1}
              max={100}
              value={maxHops ?? 50}
              onChange={(e) => setMaxHops(Number(e.target.value))}
              className="w-full"
            />
            <span className="text-sm font-medium min-w-max">
              Sectors to hop: {maxHops}
            </span>
          </div>
        )}
        <Button
          onClick={() =>
            dispatchEvent({
              ...GET_MAP_REGION,
              payload: {
                center_sector: fromSectorId,
                max_hops: maxHops,
              },
            })
          }
        >
          Get regional map
        </Button>
        Target sector:
        <input
          type="number"
          defaultValue={targetSectorId ?? 0}
          onChange={(e) => setTargetSectorId(Number(e.target.value))}
        />
        <Button
          onClick={() =>
            sendUserTextInput?.(
              `Plot a course to sector ${targetSectorId} but do not move yet. Just plot the course. If you have already plotted the same course, do it again.`
            )
          }
        >
          Plot course to sector {targetSectorId}
        </Button>
        <Button onClick={() => clearCoursePlot?.()}>Clear course plot</Button>
      </div>
      <Divider />
      <MapScreen />
    </div>
  );
};

MapPanelStory.meta = {
  enableMic: false,
  disableAudioOutput: true,
};

const storyData: MapData = [
  {
    id: 0,
    visited: true,
    hops_from_center: 0,
    adjacent_sectors: [581, 657, 849],
    port: "SSS",
    last_visited: "2025-10-30T04:36:16.606627+00:00",
    position: [126, 126],
    lanes: [
      {
        to: 581,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 657,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 849,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 126,
    visited: false,
    hops_from_center: 2,
    position: [128, 128],
    port: "",
    lanes: [
      {
        to: 581,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 492,
    visited: false,
    hops_from_center: 3,
    position: [130, 122],
    port: "",
    lanes: [
      {
        to: 1284,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 581,
    visited: true,
    hops_from_center: 1,
    adjacent_sectors: [0, 126, 1284],
    port: "BBB",
    last_visited: "2025-10-30T04:09:49.773873+00:00",
    position: [128, 126],
    lanes: [
      {
        to: 0,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 126,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 1284,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 657,
    visited: true,
    hops_from_center: 3,
    adjacent_sectors: [0, 389, 849],
    port: "",
    last_visited: "2025-10-30T04:54:36.096804+00:00",
    position: [124, 127],
    lanes: [
      {
        to: 0,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 389,
        two_way: false,
        hyperlane: false,
      },
      {
        to: 849,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 849,
    visited: false,
    hops_from_center: 1,
    position: [124, 126],
    port: "",
    lanes: [
      {
        to: 0,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 1284,
    visited: true,
    hops_from_center: 2,
    adjacent_sectors: [492, 581, 1401],
    port: "",
    last_visited: "2025-10-28T15:32:01.881034+00:00",
    position: [129, 123],
    lanes: [
      {
        to: 492,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 581,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 1401,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 1401,
    visited: false,
    hops_from_center: 3,
    position: [128, 122],
    port: "",
    lanes: [
      {
        to: 1284,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
];

const storyData2: MapData = [
  {
    id: 0,
    visited: true,
    hops_from_center: 2,
    adjacent_sectors: [581, 657, 849],
    port: "SSS",
    last_visited: "2025-10-30T04:56:42.553687+00:00",
    position: [126, 126],
    lanes: [
      {
        to: 581,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 657,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 849,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 126,
    visited: false,
    hops_from_center: 2,
    position: [128, 129],
    port: "",
    lanes: [
      {
        to: 581,
        two_way: true,
        hyperlane: false,
      },
    ],
  },

  {
    id: 492,
    visited: false,
    hops_from_center: 1,
    position: [130, 122],
    port: "",
    lanes: [
      {
        to: 1284,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 581,
    visited: true,
    hops_from_center: 1,
    adjacent_sectors: [0, 126, 1284],
    port: "BBB",
    last_visited: "2025-10-30T04:57:09.506207+00:00",
    position: [128, 126],
    lanes: [
      {
        to: 0,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 126,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 1284,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 657,
    visited: true,
    hops_from_center: 3,
    adjacent_sectors: [0, 389, 849],
    port: "",
    last_visited: "2025-10-30T04:54:36.096804+00:00",
    position: [124, 127],
    lanes: [
      {
        to: 0,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 389,
        two_way: false,
        hyperlane: false,
      },
      {
        to: 849,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 849,
    visited: false,
    hops_from_center: 3,
    position: [124, 126],
    port: "",
    lanes: [
      {
        to: 0,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 1284,
    visited: true,
    hops_from_center: 0,
    adjacent_sectors: [492, 581, 1401],
    port: "",
    last_visited: "2025-10-30T04:57:12.957082+00:00",
    position: [129, 123],
    lanes: [
      {
        to: 492,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 581,
        two_way: true,
        hyperlane: false,
      },
      {
        to: 1401,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
  {
    id: 1401,
    visited: false,
    hops_from_center: 1,
    position: [128, 122],
    port: "",
    lanes: [
      {
        to: 1284,
        two_way: true,
        hyperlane: false,
      },
    ],
  },
];

const coursePlotMock: CoursePlot = {
  from_sector: 0,
  to_sector: 1284,
  path: [0, 581, 1284],
  distance: 2,
};

export const MiniMapMock: Story = () => {
  const coursePlot = useGameStore.use.course_plot?.();
  const setCoursePlot = useGameStore.use.setCoursePlot?.();
  const clearCoursePlot = useGameStore.use.clearCoursePlot?.();
  const [currentSectorId, setCurrentSectorId] = useState<number>(0);
  const [maxDistance, setMaxDistance] = useState<number>(2);
  const [bypassAnimation, setBypassAnimation] = useState<boolean>(false);
  const [currentStoryData, setCurrentStoryData] = useState<MapData>(storyData);

  const handleSetSector = useCallback(
    (id: number) => setCurrentSectorId(id),
    []
  );

  const config: MiniMapConfig = {
    bypass_animation: bypassAnimation,
    debug: true,
  };

  return (
    <>
      <div className="story-card space-y-3 bg-card">
        <MiniMapComponent
          current_sector_id={currentSectorId}
          config={config}
          map_data={currentStoryData}
          width={440}
          height={440}
          maxDistance={maxDistance}
          coursePlot={coursePlot}
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
            {[0, 581, 126, 1284, 849, 657].map((id) => (
              <Button size="sm" key={id} onClick={() => handleSetSector(id)}>
                Center {id}
              </Button>
            ))}
            <Button size="sm" onClick={() => setCurrentStoryData(storyData)}>
              Load Story 1
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setCurrentStoryData(storyData2);
                handleSetSector(1284);
              }}
            >
              Load Story 2
            </Button>
            <Button size="sm" onClick={() => setCoursePlot(coursePlotMock)}>
              Plot Course
            </Button>
            <Button size="sm" onClick={() => clearCoursePlot()}>
              Clear Course
            </Button>
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

export const DiscoveredPorts: Story = () => {
  return (
    <div className="flex flex-col gap-3">
      <DiscoveredPortsPanel />
    </div>
  );
};

DiscoveredPorts.meta = {
  enableMic: false,
  disableAudioOutput: true,
};
