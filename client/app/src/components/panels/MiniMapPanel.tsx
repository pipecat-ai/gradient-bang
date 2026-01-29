import { useMemo } from "react"

import { ArrowRightIcon, ArrowUpLeftIcon, SphereIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { calculateHopsRemaining } from "@/utils/game"
import { cn } from "@/utils/tailwind"

import { PortBadge } from "../PortBadge"
import { Badge } from "../primitives/Badge"
import { Button } from "../primitives/Button"
import { Card, CardContent } from "../primitives/Card"
import { SectorBadge } from "../SectorBadge"
import SectorMap, { type MapConfig } from "../SectorMap"

const MINIMAP_CONFIG: MapConfig = {
  hoverable: false,
  show_sector_ids: false,
}

export const MiniMapPanel = ({ className }: { className?: string }) => {
  const setActiveScreen = useGameStore.use.setActiveScreen?.()
  const sector = useGameStore((state) => state.sector)
  const localMapData = useGameStore((state) => state.local_map_data)
  const ships = useGameStore.use.ships?.()
  const coursePlot = useGameStore.use.course_plot?.()
  const setLookMode = useGameStore.use.setLookMode?.()
  const shipSectors = ships?.data
    ?.filter((s: ShipSelf) => s.owner_type !== "personal")
    .map((s: ShipSelf) => s.sector ?? 0)

  const hopsRemaining = useMemo(
    () => calculateHopsRemaining(sector, coursePlot),
    [sector, coursePlot]
  )

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
          <Button
            variant="outline"
            className="shrink-0 bg-background hover:bg-accent-background"
            onClick={() => setLookMode(true)}
          >
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
      {coursePlot && (
        <Card
          size="xxs"
          variant="stripes"
          className="absolute top-0 left-0 right-0 bg-fuel-background/80 stripe-frame-fuel text-xs"
        >
          <CardContent className="flex flex-row justify-between">
            <div className="flex flex-col gap-1 justify-between">
              <header className="font-extrabold uppercase text-fuel-foreground animate-pulse">
                Autopilot Active
              </header>
              <div className="flex flex-row text-xxs gap-2 items-center">
                <span className="uppercase">{coursePlot.from_sector}</span>
                <ArrowRightIcon size={12} className="size-3 opacity-50" />
                <span className="uppercase">{coursePlot.to_sector}</span>
              </div>
            </div>
            <Badge
              size="sm"
              className="flex flex-col text-xxs elbow-offset-0 elbow-fuel border-0 bg-fuel-background leading-3"
              border="elbow"
            >
              <span className="font-bold">{hopsRemaining}</span>
              <span className="opacity-60">Hops Remain</span>
            </Badge>
          </CardContent>
        </Card>
      )}
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
