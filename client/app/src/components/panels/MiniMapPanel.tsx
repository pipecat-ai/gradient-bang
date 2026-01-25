import useGameStore from "@/stores/game"

import SectorMap, { type MapConfig } from "../SectorMap"

const MINIMAP_CONFIG: MapConfig = {}

export const MiniMapPanel = () => {
  const sector = useGameStore((state) => state.sector)
  const localMapData = useGameStore((state) => state.local_map_data)
  const ships = useGameStore.use.ships?.()

  const shipSectors = ships?.data
    ?.filter((s: ShipSelf) => s.owner_type !== "personal")
    .map((s: ShipSelf) => s.sector ?? 0)

  return (
    <div className="bg-card border">
      <SectorMap
        current_sector_id={sector?.id ?? 0}
        config={MINIMAP_CONFIG}
        ships={shipSectors}
        map_data={localMapData ?? []}
        maxDistance={4}
      />
    </div>
  )
}
