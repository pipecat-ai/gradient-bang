import useGameStore from "@/stores/game"

import SectorMap, { type MapConfig } from "../SectorMap"

const MINIMAP_CONFIG: MapConfig = {}

export const MiniMapPanel = () => {
  const sector = useGameStore((state) => state.sector)
  const localMapData = useGameStore((state) => state.local_map_data)
  return (
    <div className="w-[440px] h-[440px] bg-card border">
      <SectorMap
        current_sector_id={sector?.id ?? 0}
        config={MINIMAP_CONFIG}
        map_data={localMapData ?? []}
        maxDistance={4}
      />
    </div>
  )
}
