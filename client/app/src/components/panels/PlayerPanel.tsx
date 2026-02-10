import { format } from "date-fns"
import { UserIcon } from "@phosphor-icons/react"

import RadialGrad from "@/assets/images/radial-grad-md.png"
import useGameStore from "@/stores/game"

import { DottedTitle } from "../DottedTitle"
import { Button } from "../primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { ShipLogoPopover } from "../ShipLogoPopover"
import { MovementHistoryPanel } from "./DataTablePanels"
import { RHSPanelContent, RHSSubPanel } from "./RHSPanelContainer"
import { ShipCatalogue } from "./ShipCatalogue"

import { SHIP_DEFINITIONS } from "@/types/ships"

export const PlayerPanel = () => {
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()
  const player = useGameStore.use.player?.()
  const corporation = useGameStore.use.corporation?.()
  const ship = useGameStore.use.ship?.()

  return (
    <RHSPanelContent>
      <header className="flex flex-col items-center justify-center py-ui-sm">
        <figure className="z-10 relative size-21 bg-background p-1 elbow -elbow-offset-4 elbow-size-8 elbow-1 elbow-subtle border border-terminal">
          <div className="h-full flex flex-col items-center justify-center bg-accent shrink-0 text-subtle-background dither-mask-md">
            <UserIcon weight="duotone" className="size-7 text-foreground relative z-10" />
          </div>
        </figure>

        <Card size="sm" className="relative w-full border-x-0 -mt-ui-lg pt-ui-lg overflow-hidden">
          <img
            src={RadialGrad}
            alt=""
            className="absolute -top-[128px] left-1/2 -translate-x-1/2 opacity-25 select-none"
          />

          <CardTitle className="text-base normal-case py-ui-sm flex flex-col items-center justify-center">
            {player?.name ?? "---"}
            <span className="text-xxs uppercase text-subtle-foreground">
              Joined {player.created_at ? format(player.created_at, "MMM d, yyyy") : "---"}
            </span>
          </CardTitle>
          <CardContent className="grid grid-cols-2 gap-ui-xxs uppercase">
            <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
              <span className="text-xxs uppercase text-subtle-foreground">Rank</span>
              <span className="text-xs font-medium">Pilot</span>
            </div>
            <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
              <span className="text-xxs uppercase text-subtle-foreground">Corporation</span>
              <span className="text-xs font-medium truncate">{corporation?.name ?? "None"}</span>
            </div>
            <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
              <span className="text-xxs uppercase text-subtle-foreground">Sector Discovery</span>
              <span className="text-xs font-bold">
                {player?.sectors_visited ?? 0} (
                {player?.universe_size ?
                  ((player.sectors_visited / player.universe_size) * 100).toFixed(2)
                : "0.00"}
                %)
              </span>
            </div>
            <div className="corner-dots gap-0.5 p-ui-xs flex flex-col border border-accent bg-subtle-background">
              <span className="text-xxs uppercase text-subtle-foreground">Combat Victories</span>
              <span className="text-sm font-bold text-subtle">---</span>
            </div>
          </CardContent>
          <CardContent>
            <DottedTitle title="Ship" />
            <div className="flex-1 flex flex-row uppercase items-center pt-ui-xs">
              <ShipLogoPopover
                ship_type={ship?.ship_type}
                alt={ship?.ship_name}
                className="px-ui-sm"
              />
              <div className="flex flex-col gap-ui-xxs border-l border-accent pl-ui-sm">
                <span className="text-sm font-medium truncate">{ship?.ship_name ?? "---"}</span>
                <span className="text-xxs text-subtle-foreground">
                  {SHIP_DEFINITIONS.find((s) => s.ship_type === ship?.ship_type)?.display_name ??
                    "---"}
                </span>
              </div>
            </div>
            <Divider className="my-ui-sm bg-border" />
            <Button
              variant="default"
              size="sm"
              onClick={() => setActiveSubPanel("ship-catalog")}
              className="w-full"
            >
              Browse Ship Upgrades
            </Button>
          </CardContent>
        </Card>
      </header>

      <Card size="sm" className="border-0 border-y">
        <CardHeader className="shrink-0">
          <CardTitle>Movement History</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-row gap-ui-sm">
          <div className="text-xs flex flex-col flex-1">
            <MovementHistoryPanel className="max-h-[280px]" />
          </div>
        </CardContent>
      </Card>

      <RHSSubPanel>
        <ShipCatalogue />
      </RHSSubPanel>
    </RHSPanelContent>
  )
}
