import { useMemo } from "react"

import { GarrisonUpdateForm } from "@/components/panels/GarrisonUpdateForm"
import { CardContent } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

export const GarrisonPanel = ({ garrison }: { garrison: Garrison }) => {
  const player = useGameStore.use.player?.()
  const fighterAttrition = garrison.fighter_loss > 0 ? garrison.fighter_loss / garrison.fighters : 0

  const isPlayerGarrison = useMemo(
    () => garrison.owner_id === player.id,
    [garrison.owner_id, player.id]
  )

  return (
    <>
      <CardContent className="grid grid-cols-2 gap-ui-xxs uppercase">
        <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
          <span className="text-xxs uppercase text-subtle-foreground">Mode</span>
          <span
            className={cn(
              "text-xs font-medium",
              garrison.mode === "offensive" && "text-destructive",
              garrison.mode === "defensive" && "text-fuel",
              garrison.mode === "toll" && "text-warning"
            )}
          >
            {garrison?.mode ?? "Unknown"}
          </span>
        </div>
        <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
          <span className="text-xxs uppercase text-subtle-foreground">Owner name</span>
          <span className="text-xs font-medium truncate">{garrison?.owner_name ?? "Unknown"}</span>
        </div>
        <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
          <span className="text-xxs uppercase text-subtle-foreground">Fighters</span>
          <span className="text-xs font-medium">{garrison?.fighters ?? 0}</span>
        </div>
        <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
          <span className="text-xxs uppercase text-subtle-foreground">Fighter attrition</span>
          <span className="text-xs font-medium">
            {garrison?.fighter_loss ?? 0} ({(fighterAttrition * 100).toFixed()}%)
          </span>
        </div>
        <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
          <span className="text-xxs uppercase text-subtle-foreground">Toll</span>
          <span className="text-xs font-medium">
            {formatCurrency(garrison?.toll_amount ?? 0)} CR
          </span>
        </div>
        <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
          <span className="text-xxs uppercase text-subtle-foreground">Toll collected</span>
          <span className="text-xs font-medium">
            {formatCurrency(garrison?.toll_balance ?? 0)} CR
          </span>
        </div>
      </CardContent>

      {isPlayerGarrison && <GarrisonUpdateForm garrison={garrison} />}
    </>
  )
}
