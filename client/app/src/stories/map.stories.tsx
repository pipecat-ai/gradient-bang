import { useCallback } from "react";

import { button, folder, useControls } from "leva"
import { Story } from "@ladle/react"

import SectorMap, { type MapConfig } from "@/components/SectorMap";
import { useGameContext } from "@/hooks/useGameContext";
import useGameStore from "@/stores/game";

import { SMALL_MAP_DATA_MOCK } from "@/mocks/map.mock";

export const BigMapStory: Story = () => {
  const { dispatchAction, } = useGameContext();

  const localMapData = useGameStore((state) => state.local_map_data);
  const sector = useGameStore((state) => state.sector);
  const setLocalMapData = useGameStore.use.setLocalMapData?.();

  const [{ center_sector, show_legend }, set] = useControls(() => ({
    "Map": folder({
      ["Get My Map"]: button((get) => {
        dispatchAction({ type: "get-my-map", payload: { center_sector: get('center_sector') } })
      }),
      ["Load Small Mock"]: button(() => {
        setLocalMapData(SMALL_MAP_DATA_MOCK);
      }),
      center_sector: {
        value: sector?.id ?? 0,
        step: 1,
      },
      max_hops: {
        value: 15,
        min: 1,
        max: 100,
        step: 1,
      },
      max_sectors: {
        value: 500,
        min: 1,
        max: 1000,
        step: 1,
      },
      show_legend: {
        value: true,
      },
    }, { collapsed: false })
  }))

  const [mapConfig] = useControls(() => ({
    "Config": folder({
      debug: {
        value: true,
      },
      clickable: {
        value: true,
      },
      max_bounds_distance: {
        value: 100,
        min: 1,
        max: 1000,
        step: 1,
      },
      show_sector_ids: {
        value: true,
      },
      show_partial_lanes: {
        value: true,
      },
      show_ports: {
        value: false,
      },
      show_hyperlanes: {
        value: false,
      },
      show_grid: {
        value: true,
      },
    }, { collapsed: true }),
  }))

  const updateCenterSector = useCallback((node: MapSectorNode) => {
    set({ center_sector: node.id ?? 0 });
  }, [set]);

  return <div>
    {mapConfig && (
      <SectorMap
        current_sector_id={center_sector}
        config={mapConfig as MapConfig}
        map_data={localMapData ?? []}
        width={1100}
        height={780}
        showLegend={show_legend}
        onNodeClick={updateCenterSector}
      />
    )}
  </div>
}

BigMapStory.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  useDevTools: true,
}