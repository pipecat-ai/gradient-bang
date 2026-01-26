import { ArrowsOutSimpleIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { Badge } from "../primitives/Badge"
import { Button } from "../primitives/Button"
import SectorMap, { type MapConfig } from "../SectorMap"

const MINIMAP_CONFIG: MapConfig = {}

export const MiniMapPanel = ({ className }: { className?: string }) => {
  const setActiveScreen = useGameStore.use.setActiveScreen?.()
  const sector = useGameStore((state) => state.sector)
  const localMapData = useGameStore((state) => state.local_map_data)
  const ships = useGameStore.use.ships?.()

  const shipSectors = ships?.data
    ?.filter((s: ShipSelf) => s.owner_type !== "personal")
    .map((s: ShipSelf) => s.sector ?? 0)

  return (
    <div className={cn("bg-card border relative", className)}>
      <Badge
        variant="secondary"
        border="elbow"
        className="absolute top-ui-xs left-ui-xs -elbow-offset-2 px-0 py-0 bg-muted/30"
      >
        <Button variant="secondary" size="icon" className="" onClick={() => setActiveScreen("map")}>
          <ArrowsOutSimpleIcon weight="bold" size={16} className="scale-x-[-1]" />
        </Button>
      </Badge>
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
