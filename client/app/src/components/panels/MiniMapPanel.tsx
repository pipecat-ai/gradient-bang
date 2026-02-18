import { useMemo } from "react"

import { ArrowRightIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { calculateHopsRemaining } from "@/utils/game"
import { cn } from "@/utils/tailwind"

import { PortBadge } from "../PortBadge"
import { Badge } from "../primitives/Badge"
import { Card, CardContent } from "../primitives/Card"
import { SectorBadge } from "../SectorBadge"
import SectorMap, { type MapConfig } from "../SectorMap"

const MINIMAP_CONFIG: MapConfig = {
  hoverable: true,
  show_sector_ids: false,
  show_sector_ids_hover: true,
  uiStyles: {
    edgeFeather: {
      size: 80,
      falloff: 1.5,
    },
  },
  nodeStyles: {
    current: {
      offset: true,
      offsetColor: "rgba(255,255,255,0.4)",
      offsetSize: 12,
      offsetWeight: 2,
    },
  },
}

const MAX_DISTANCE = 4

export const MiniMapPanel = ({ className }: { className?: string }) => {
  const uiState = useGameStore.use.uiState()
  const sector = useGameStore((state) => state.sector)
  const localMapData = useGameStore((state) => state.local_map_data)
  const ships = useGameStore.use.ships?.()
  const coursePlot = useGameStore.use.course_plot?.()
  const shipSectors = ships?.data
    ?.filter((s: ShipSelf) => s.owner_type !== "personal")
    .map((s: ShipSelf) => s.sector ?? 0)

  const hasRouteHighlight = Boolean(coursePlot?.path && coursePlot.path.length > 1)
  const hopsRemaining = useMemo(
    () => (hasRouteHighlight ? calculateHopsRemaining(sector, coursePlot) : 0),
    [sector, coursePlot, hasRouteHighlight]
  )
  return (
    <div
      className={cn(
        "group relative h-full",
        className,
        uiState === "combat" ? "pointer-events-none" : "pointer-events-auto"
      )}
    >
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-600 ease-in-out z-10 pointer-events-none",
          uiState === "combat" ? "group-hover:opacity-0" : "group-hover:opacity-100"
        )}
      ></div>
      <Badge
        variant="secondary"
        border="elbow"
        className="absolute top-ui-xs left-ui-xs -elbow-offset-2 px-0 py-0 bg-muted/30"
      ></Badge>
      {coursePlot && uiState !== "combat" && (
        <Card
          size="xxs"
          variant="stripes"
          className="absolute top-0 left-0 right-0 bg-fuel-background/80 stripe-frame-fuel text-xs"
        >
          <CardContent className="flex flex-row justify-between">
            <div className="flex flex-col gap-1 justify-between">
              <header className="font-extrabold uppercase text-fuel-foreground animate-pulse">
                Route Highlighted
              </header>
              <div className="flex flex-row text-xxs gap-2 items-center">
                <span className="uppercase">{coursePlot.from_sector}</span>
                <ArrowRightIcon size={12} className="size-3 opacity-50" />
                <span className="uppercase">{coursePlot.to_sector}</span>
              </div>
            </div>
            {typeof hopsRemaining === "number" && (
              <Badge
                size="sm"
                className="flex flex-col text-xxs elbow-offset-0 elbow-fuel border-0 bg-fuel-background leading-3"
                border="elbow"
              >
                <span className="font-bold">{hopsRemaining}</span>
                <span className="opacity-60">Hops Remain</span>
              </Badge>
            )}
          </CardContent>
        </Card>
      )}
      <div className="relative w-full h-full z-1 pb-12">
        <SectorMap
          current_sector_id={sector?.id ?? 0}
          maxDistance={MAX_DISTANCE}
          config={MINIMAP_CONFIG}
          ships={shipSectors}
          map_data={localMapData ?? []}
        />
      </div>
      <div className="absolute left-1.5 bottom-1.5 right-0 flex flex-col gap-1.5 z-2">
        <div className="h-[6px] dashed-bg-horizontal dashed-bg-foreground/30 shrink-0" />
        <div className="flex flex-row gap-1.5">
          <SectorBadge />
          <PortBadge />
        </div>
      </div>
    </div>
  )
}
