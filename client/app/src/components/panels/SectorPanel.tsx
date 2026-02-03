import { type ReactNode, useMemo } from "react"

import type { Icon } from "@phosphor-icons/react"
import {
  ArrowRightIcon,
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
import { cn } from "@/utils/tailwind"

import { PanelContentLoader } from "../PanelContentLoader"
import { Button } from "../primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { ChevronSM } from "../svg/ChevronSM"
import { RHSPanelContent } from "./RHSPanelContainer"

interface SectorInfoRowProps {
  label: string
  value?: ReactNode
  empty?: string
  Icon: Icon
  count?: number
  valueClassName?: string
  onClick?: () => void
}

const SectorInfoRow = ({
  label,
  value,
  empty = "N/A",
  Icon,
  count,
  valueClassName,
  onClick,
}: SectorInfoRowProps) => {
  const isEmpty = value === undefined || value === null || value === ""

  return (
    <div className="flex flex-row items-center">
      <div className="bg-accent-background p-ui-xs flex items-center justify-center corner-dots border border-accent">
        <Icon size={16} weight="duotone" />
      </div>
      <div className="w-12">
        <Divider className="bg-accent" />
      </div>
      <div className="flex flex-row flex-1 h-full justify-between items-center px-ui-sm bg-subtle-background bracket bracket-offset-0 bracket-accent">
        <span className="font-bold inline-flex items-center gap-2">
          {count !== undefined ?
            <span className={cn("text-xs font-bold", count > 0 ? "text-terminal" : "text-subtle")}>
              {count}
            </span>
          : null}

          {label}
        </span>
        {onClick ?
          <Button variant="link" size="sm" onClick={onClick} className="px-0! text-xs">
            View <ArrowRightIcon size={16} />
          </Button>
        : <span className={cn(isEmpty ? "text-subtle" : "", valueClassName)}>
            {isEmpty ? empty : value}
          </span>
        }
      </div>
    </div>
  )
}

export const SectorPanel = () => {
  const sector = useGameStore.use.sector?.()
  const setActivePanel = useGameStore.use.setActivePanel?.()

  const playerCount = useMemo(() => sector?.players?.length ?? 0, [sector?.players])

  return (
    <RHSPanelContent>
      <Card size="sm" className="border-0 border-b">
        <CardHeader className="gap-0">
          <CardTitle>Sector {sector?.id}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-row gap-ui-sm pr-0">
          <div className="text-xs uppercase flex flex-col gap-ui-xxs flex-1">
            <SectorInfoRow label="Zone" value={sector?.region} empty="Unknown" Icon={GpsIcon} />
            <SectorInfoRow
              label="Hostility"
              value={sector?.region === "Federation Space" ? "Safe" : "Dangerous"}
              Icon={ShieldChevronIcon}
              valueClassName="text-success-foreground"
            />
            <SectorInfoRow
              label="Adjacent"
              value={sector?.adjacent_sectors?.join(", ")}
              Icon={FlowArrowIcon}
            />
            <SectorInfoRow label="Last visit" value={undefined} Icon={ClockCounterClockwiseIcon} />
            <SectorInfoRow
              label="Salvage"
              count={sector?.salvage?.length ?? 0}
              value={undefined}
              Icon={SalvageIcon}
              onClick={() => console.log("salvage")}
            />
          </div>
        </CardContent>
        <CardContent className="relative text-xs uppercase">
          <Divider variant="dotted" className="h-[6px] mb-ui-sm text-accent-background" />
          <Button
            variant="ghost"
            onClick={() => setActivePanel("trade")}
            className={cn(
              "w-full relative px-0 text-xs hover:bg-fuel-background/40 text-foreground",
              sector?.port ?
                "bg-fuel-background/60 text-fuel-foreground border border-fuel"
              : "text-subtle-background after:content-[''] after:absolute after:inset-0 after:bg-stripes-sm after:bg-stripes-accent-background"
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
                {sector?.port ? "View " + sector?.port?.code + " port" : "No port in sector"}
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
          <div className="text-xs uppercase flex flex-col gap-ui-xxs flex-1">
            <SectorInfoRow
              label="Humans"
              value="view"
              empty="Unknown"
              Icon={UserIcon}
              count={playerCount}
              onClick={() => setActivePanel("trade")}
            />
            <SectorInfoRow
              label="Autonomous"
              value="view"
              empty="Unknown"
              Icon={HeadCircuitIcon}
              count={0}
              onClick={() => setActivePanel("trade")}
            />
            <Divider variant="dotted" className="h-[6px] my-ui-xs text-accent-background" />
            <SectorInfoRow
              label="Unmanned"
              value="view"
              empty="Unknown"
              Icon={EmptyIcon}
              count={sector?.unowned_ships?.length ?? 0}
              onClick={() => setActivePanel("trade")}
            />
            <Divider variant="dotted" className="h-[6px] my-ui-xs text-accent-background" />
          </div>
        </CardContent>
      </Card>
      <Card size="sm" className="border-x-0 border-y">
        <CardHeader>
          <CardTitle>Salvage</CardTitle>
        </CardHeader>
        <CardContent>
          <div>
            <PanelContentLoader className="mx-auto" />
          </div>
        </CardContent>
      </Card>
    </RHSPanelContent>
  )
}

// - player count / ships in sector
// - unowned ships
// - salvage
// - garrisons
// - planets

// - player list -> player sub panel
