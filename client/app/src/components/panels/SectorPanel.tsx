import { useMemo, useState } from "react"

import {
  ClockCounterClockwiseIcon,
  EmptyIcon,
  FlowArrowIcon,
  GpsIcon,
  HeadCircuitIcon,
  ShieldChevronIcon,
  UserIcon,
} from "@phosphor-icons/react"

import { SalvageIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { getPortCode } from "@/utils/port"
import { cn } from "@/utils/tailwind"

import { BlankSlateTile } from "../BlankSlates"
import { Button } from "../primitives/Button"
import { ButtonGroup } from "../primitives/ButtonGroup"
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { ChevronSM } from "../svg/ChevronSM"
import { CombatAsidePanel } from "./CombatAsidePanel"
import { SectorPlayerMovementPanel } from "./DataTablePanels"
import { RHSPanelContent, RHSSubPanel } from "./RHSPanelContainer"
import { RHSPanelList, RHSPanelListItem } from "./RHSPanelList"
import { SectorSalvageSubPanel } from "./SectorSalvageSubPanel"
import { SectorShipSubPanel } from "./SectorShipSubPanel"
import { SectorUnownedSubPanel } from "./SectorUnownedSubPanel"

export const SectorPanel = () => {
  const sector = useGameStore.use.sector?.()
  const setActivePanel = useGameStore.use.setActivePanel?.()
  const activeSubPanel = useGameStore.use.activeSubPanel?.()
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()
  const uiState = useGameStore.use.uiState?.()

  const [shipSubPanelFilter, setShipSubPanelFilter] = useState<PlayerType>("human")

  const humanPlayerCount = useMemo(
    () =>
      sector?.players?.length ?
        sector?.players.filter((player) => player.player_type === "human").length
      : 0,
    [sector?.players]
  )
  const autonomousPlayerCount = useMemo(
    () =>
      sector?.players?.length ?
        sector?.players.filter(
          (player) => player.player_type === "corporation_ship" || player.player_type === "npc"
        ).length
      : 0,
    [sector?.players]
  )
  const portCode = useMemo(() => getPortCode(sector?.port ?? null), [sector?.port])

  return (
    <>
      <RHSPanelContent>
        {uiState === "combat" && <CombatAsidePanel />}

        <Card
          size="sm"
          className={cn("border-0", uiState === "combat" ? "border-b border-t" : "border-b")}
        >
          <CardHeader className="gap-0">
            <CardTitle>Sector {sector?.id}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-row gap-ui-sm pr-0">
            <RHSPanelList>
              <RHSPanelListItem
                label="Zone"
                value={sector?.region}
                empty="Unknown"
                Icon={GpsIcon}
              />
              <RHSPanelListItem
                label="Hostility"
                value={sector?.region === "Federation Space" ? "Safe" : "Dangerous"}
                Icon={ShieldChevronIcon}
                valueClassName="text-success-foreground"
              />
              <RHSPanelListItem
                label="Adjacent"
                value={sector?.adjacent_sectors?.join(", ")}
                Icon={FlowArrowIcon}
              />
              <RHSPanelListItem
                label="Last visit"
                value={undefined}
                Icon={ClockCounterClockwiseIcon}
              />
              <RHSPanelListItem
                label="Salvage"
                count={sector?.salvage?.length ?? 0}
                value={undefined}
                Icon={SalvageIcon}
                onClick={() => setActiveSubPanel("salvage")}
              />
            </RHSPanelList>
          </CardContent>
          <CardContent className="relative text-xs uppercase">
            <Divider variant="dotted" className="h-1.5 mb-ui-sm text-accent-background" />
            <Button
              variant="ghost"
              disabled={!sector?.port}
              onClick={() => {
                if (sector?.port) {
                  setActivePanel("trade")
                }
              }}
              className={cn(
                "w-full relative px-0 text-xs hover:bg-fuel-background/40 text-foreground",
                sector?.port ?
                  "bg-fuel-background/60 text-fuel-foreground border border-fuel"
                : "disabled:opacity-100 text-subtle-background after:content-[''] after:absolute after:inset-0 after:bg-stripes-sm after:bg-stripes-accent-background"
              )}
            >
              <div className="flex-1 flex flex-row items-center justify-between p-ui-xs">
                <div className="inline-flex items-center gap-0.5">
                  <ChevronSM className="size-3 text-fuel -rotate-90" />
                  <ChevronSM className="size-3 text-fuel -rotate-90 opacity-50" />
                  <ChevronSM className="size-3 text-fuel -rotate-90 opacity-20" />
                </div>
                <span
                  className={cn(
                    sector?.port ? "text-fuel-foreground font-bold  z-10" : "text-subtle z-10"
                  )}
                >
                  {sector?.port ? "View " + portCode + " port" : "No port in sector"}
                </span>
                <div className="inline-flex items-center gap-0.5">
                  <ChevronSM className="size-3 text-fuel rotate-90 opacity-20" />
                  <ChevronSM className="size-3 text-fuel rotate-90 opacity-50" />
                  <ChevronSM className="size-3 text-fuel rotate-90" />
                </div>
              </div>
            </Button>
          </CardContent>
        </Card>
        <Card size="sm" className="border-x-0 border-y">
          <CardHeader>
            <CardTitle>Ships in sector</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-row gap-ui-sm pr-0">
            <RHSPanelList>
              <RHSPanelListItem
                label="Humans"
                value="view"
                empty="Unknown"
                Icon={UserIcon}
                count={humanPlayerCount}
                onClick={() => {
                  setShipSubPanelFilter("human")
                  setActiveSubPanel("players")
                }}
              />
              <RHSPanelListItem
                label="Autonomous"
                value="view"
                empty="Unknown"
                Icon={HeadCircuitIcon}
                count={autonomousPlayerCount}
                onClick={() => {
                  setShipSubPanelFilter("corporation_ship")
                  setActiveSubPanel("players")
                }}
              />
              <Divider
                variant="dotted"
                className="h-1.5 my-ui-xs text-accent-background shrink-0"
              />
              <RHSPanelListItem
                label="Unmanned"
                value="view"
                empty="Unknown"
                Icon={EmptyIcon}
                count={sector?.unowned_ships?.length ?? 0}
                onClick={() => setActiveSubPanel("unowned")}
              />
              <Divider
                variant="dotted"
                className="h-1.5 my-ui-xs text-accent-background shrink-0"
              />
              <SectorPlayerMovementPanel className="max-h-70" />
            </RHSPanelList>
          </CardContent>
        </Card>
        <Card size="sm" className="border-x-0 border-y">
          <CardHeader>
            <CardTitle>Garrisons</CardTitle>
          </CardHeader>
          <CardContent>
            <BlankSlateTile text="No garrisons in sector" />
          </CardContent>
        </Card>
        <Card size="sm" className="border-x-0 border-y">
          <CardHeader>
            <CardTitle>Planets</CardTitle>
          </CardHeader>
          <CardContent>
            <BlankSlateTile text="No planets in sector" />
          </CardContent>
        </Card>
      </RHSPanelContent>

      <RHSSubPanel
        headerContent={
          activeSubPanel === "players" ?
            <ButtonGroup className="bg-background/60">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShipSubPanelFilter("human")}
                className={
                  shipSubPanelFilter === "human" ? "bg-background text-accent-foreground" : ""
                }
              >
                Human
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShipSubPanelFilter("corporation_ship")}
                className={
                  shipSubPanelFilter === "corporation_ship" ?
                    "bg-background text-accent-foreground"
                  : ""
                }
              >
                Autonomous
              </Button>
            </ButtonGroup>
          : undefined
        }
      >
        {activeSubPanel === "players" && (
          <SectorShipSubPanel sector={sector} filter={shipSubPanelFilter} />
        )}
        {activeSubPanel === "unowned" && <SectorUnownedSubPanel sector={sector} />}
        {activeSubPanel === "salvage" && <SectorSalvageSubPanel sector={sector} />}
      </RHSSubPanel>
    </>
  )
}
