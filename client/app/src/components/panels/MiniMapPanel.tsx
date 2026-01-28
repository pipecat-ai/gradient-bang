import { ArrowUpLeftIcon, SphereIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { PortBadge } from "../PortBadge"
import { Badge } from "../primitives/Badge"
import { Button } from "../primitives/Button"
import { SectorBadge } from "../SectorBadge"
import SectorMap, { type MapConfig } from "../SectorMap"

const MINIMAP_CONFIG: MapConfig = {
  hoverable: false,
}

export const MiniMapPanel = ({ className }: { className?: string }) => {
  const setActiveScreen = useGameStore.use.setActiveScreen?.()
  const sector = useGameStore((state) => state.sector)
  const localMapData = useGameStore((state) => state.local_map_data)
  const ships = useGameStore.use.ships?.()

  const shipSectors = ships?.data
    ?.filter((s: ShipSelf) => s.owner_type !== "personal")
    .map((s: ShipSelf) => s.sector ?? 0)

  return (
    <div className={cn("group relative", className)}>
      <div className="absolute inset-0 flex items-center justify-center opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-600 ease-in-out">
        <div className="bg-background/60 p-5 flex flex-col gap-1 shrink-0">
          <Button
            variant="outline"
            className="shrink-0 bg-background hover:bg-accent-background"
            onClick={() => setActiveScreen("map")}
          >
            <ArrowUpLeftIcon size={20} className="size-5" />
            <span className="flex-1 text-xs px-4">View map</span>
          </Button>
          <Button variant="outline" className="shrink-0 bg-background hover:bg-accent-background">
            <SphereIcon size={20} className="size-5" />
            <span className="flex-1 text-xs px-4">Look around</span>
          </Button>
        </div>
      </div>
      <Badge
        variant="secondary"
        border="elbow"
        className="absolute top-ui-xs left-ui-xs -elbow-offset-2 px-0 py-0 bg-muted/30"
      ></Badge>
      <SectorMap
        current_sector_id={sector?.id ?? 0}
        config={MINIMAP_CONFIG}
        ships={shipSectors}
        map_data={localMapData ?? []}
        maxDistance={4}
      />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5">
        <div className="h-[6px] dashed-bg-horizontal dashed-bg-accent shrink-0" />
        <div className="flex flex-row gap-1.5">
          <SectorBadge />
          <PortBadge />
        </div>
      </div>
    </div>
  )
}
