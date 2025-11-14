import { PortBadge } from "@/components/PortBadge"
import { Card } from "@/components/primitives/Card"
import { SectorBadge } from "@/components/SectorBadge"
import MiniMap from "@/hud/MiniMap"
import useGameStore from "@/stores/game"

import { Separator } from "../primitives/Separator"
import { SectorDetailBadges } from "../SectorDetailBadges"

export const LHS = () => {
  const sector = useGameStore((state) => state.sector)
  const localMapData = useGameStore((state) => state.local_map_data)

  return (
    <div className="lhs-perspective flex flex-col gap-3 justify-end">
      <div className="flex flex-row gap-4">
        <div className="relative flex-1 min-w-[448px] h-[350px] shrink-0">
          <Card
            className="-elbow-offset-3 absolute inset-0 border-2 border-white/20 bg-transport p-0 pointer-events-none select-none"
            elbow={true}
          />
          {sector && localMapData && (
            <MiniMap
              current_sector_id={sector.id}
              map_data={localMapData}
              maxDistance={2}
              showLegend={false}
            />
          )}
        </div>
        <SectorDetailBadges />
      </div>
      <Separator variant="dotted" className="w-full text-white/20 h-[12px]" />
      <footer className="flex flex-row gap-2 flex-1">
        <SectorBadge className="w-full" />
        <PortBadge className="w-full" />
      </footer>
    </div>
  )
}
