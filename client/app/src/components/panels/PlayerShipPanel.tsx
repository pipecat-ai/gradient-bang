import { useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { CircleNotchIcon, UserIcon, XIcon } from "@phosphor-icons/react"

import { CreditsIcon, CurrentSectorIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

import { PlayerFightersBadge, PlayerShieldsBadge, PlayerShipFuelBadge } from "../PlayerShipBadges"
import { PlayerShipCargo } from "../PlayerShipCargo"
import { PopoverHelper } from "../PopoverHelper"
import { Badge } from "../primitives/Badge"
import { Button } from "../primitives/Button"
import { Divider } from "../primitives/Divider"
import { DotDivider } from "../primitives/DotDivider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../primitives/Tabs"
import { ShipEquipmentPanel } from "./ShipEquipmentPanel"
import { ShipRenamePanel } from "./ShipRenamePanel"

const ShipBlankSlate = ({
  fetching,
  children,
}: {
  fetching?: boolean
  children?: React.ReactNode
}) => {
  return (
    <div className="py-panel-gap text-subtle text-xs uppercase font-medium leading-none select-none">
      <div className="flex flex-row gap-3 items-center justify-center p-1.5 bg-[linear-gradient(to_right,transparent_0%,var(--subtle-background)_20%,var(--subtle-background)_80%,transparent_100%)]">
        <div className="flex-1 dotted-bg-sm text-accent h-3"></div>
        <div className="flex flex-row gap-2 items-center justify-center">
          {fetching ?
            <span className="animate-pulse flex flex-row gap-2 items-center justify-center">
              <CircleNotchIcon weight="bold" className="shrink-0 size-3 animate-spin" />
              Awaiting ship data
            </span>
          : children}
        </div>
        <div className="flex-1 dotted-bg-sm text-accent h-3"></div>
      </div>
    </div>
  )
}

const ShipCard = ({ ship }: { ship: ShipSelf }) => {
  const activeTask = useGameStore((state) =>
    Object.values(state.activeTasks).find((task) => task.ship_id === ship.ship_id)
  )
  return (
    <div className="uppercase shrink-0 py-2 pb-3.5 flex flex-row gap-2 items-center justify-between">
      <div className="flex flex-col gap-2 flex-1 min-w-0">
        <div className="flex flex-row gap-2 items-center">
          <div className="text-sm uppercase text-white font-semibold">{ship.ship_name}</div>
          <div className="text-xxs text-subtle-foreground">{ship.ship_type?.replace("_", " ")}</div>
        </div>
        <div className="text-sm text-subtle-foreground flex flex-row gap-2 items-center min-w-0">
          <Badge variant="secondary" border="elbow" size="sm" className="font-semibold">
            <CurrentSectorIcon weight="duotone" className="size-4" />
            <span className="min-w-9 text-right text-muted-foreground">{ship.sector}</span>
          </Badge>
          <Badge variant="secondary" border="elbow" size="sm" className="font-semibold">
            <CreditsIcon weight="duotone" className="size-4" />
            <span
              className={cn(
                "min-w-9 text-right",
                ship.credits ? " text-muted-foreground" : "text-subtle"
              )}
            >
              {ship.credits ? formatCurrency(ship.credits) : "---"}
            </span>
          </Badge>
          <DotDivider />
          <Badge
            variant={activeTask ? "success" : "secondary"}
            border="bracket"
            size="sm"
            className="font-semibold w-20"
          >
            {activeTask ?
              <>
                <CircleNotchIcon weight="duotone" size={16} className="animate-spin" /> Active
              </>
            : <span className="text-muted-foreground">Inactive</span>}
          </Badge>
          <div
            className={cn(
              "flex flex-row gap-1 items-center text-xs truncate flex-1 min-w-0 overflow-hidden w-full",
              activeTask ? "gap-1.5 text-white" : "text-accent-foreground"
            )}
          >
            <UserIcon weight="duotone" className="size-4" />
            <span className="truncate">{activeTask ? activeTask.actor_character_name : "---"}</span>
          </div>
        </div>
      </div>
      <div></div>
    </div>
  )
}

const PlayerShipsPanelContent = ({ className }: { className?: string }) => {
  const shipsState = useGameStore.use.ships()
  const ships = shipsState.data

  return (
    <motion.div
      layout
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className={cn("bg-card border border-r-0 border-t-0", className)}
    >
      <AnimatePresence mode="wait">
        {!ships ?
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <ShipBlankSlate fetching={ships === undefined} />
          </motion.div>
        : ships.filter((ship) => ship.owner_type === "corporation").length === 0 ?
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <ShipBlankSlate>
              <span className="flex flex-row gap-2 items-center justify-center">
                No corporation ships <PopoverHelper className="text-subtle-foreground" />
              </span>
            </ShipBlankSlate>
          </motion.div>
        : <motion.div
            key="ships"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="flex flex-row gap-panel-gap px-0 py-panel-gap shrink-0">
              <div className="w-2 dashed-bg-vertical-tight dashed-bg-muted ml-panel-gap"></div>
              <div className="bg-subtle-background border border-r-0 pl-3 flex-1 overflow-hidden">
                <AnimatePresence initial={false}>
                  {ships
                    .filter((ship) => ship.owner_type === "corporation")
                    .map((ship) => (
                      <motion.div
                        key={ship.ship_id}
                        initial={{ height: 0, x: 40, opacity: 0 }}
                        animate={{ height: "auto", x: 0, opacity: 1 }}
                        exit={{ height: 0, x: 40, opacity: 0 }}
                        transition={{
                          height: { duration: 0.3, ease: "easeInOut" },
                          x: { duration: 0.25, delay: 0.3, ease: "easeOut" },
                          opacity: { duration: 0.2, delay: 0.3 },
                        }}
                        className="shadow-[inset_0_-1px_0_0_var(--border)] last:shadow-none"
                      >
                        <ShipCard ship={ship} />
                      </motion.div>
                    ))}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        }
      </AnimatePresence>
    </motion.div>
  )
}

const PlayerShip = () => {
  const ship = useGameStore((state) => state.ship)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-row gap-ui-sm items-center">
        <div className="uppercase text-white font-semibold">{ship?.ship_name ?? "---"}</div>
        <div className="text-xxs uppercase text-subtle-foreground">
          {ship?.ship_type?.replace("_", " ") ?? "---"}
        </div>
        <div className="flex-1 h-3 dashed-bg-horizontal dashed-bg-accent"></div>
      </div>
      <div className="flex flex-row items-center select-none gap-1">
        <div className="flex-1">
          <PlayerShipFuelBadge className="w-full" />
        </div>
        <div className="flex-1">
          <PlayerFightersBadge className="w-full" />
        </div>
        <div className="flex-1">
          <PlayerShieldsBadge className="w-full" />
        </div>
      </div>
    </div>
  )
}

export const PlayerShipTabControls = () => {
  const [activeTab, setActiveTab] = useState<string>("")

  const handleTabClick = (value: string) => {
    setActiveTab((prev) => (prev === value ? "" : value))
  }

  return (
    <>
      <Tabs value={activeTab} activationMode="manual">
        <TabsList className="border-l select-none">
          <TabsTrigger value="ships" onClick={() => handleTabClick("ships")}>
            Ships
          </TabsTrigger>
          <TabsTrigger value="cargo" onClick={() => handleTabClick("cargo")}>
            Cargo
          </TabsTrigger>
          <TabsTrigger value="modules" onClick={() => handleTabClick("modules")}>
            Equipment
          </TabsTrigger>
          <TabsTrigger value="config" className="border-0" onClick={() => handleTabClick("config")}>
            Config
          </TabsTrigger>
        </TabsList>
        <TabsContent value="ships">
          <PlayerShipsPanelContent />
        </TabsContent>
        <TabsContent value="cargo">
          <PlayerShipCargo />
        </TabsContent>
        <TabsContent value="modules">
          <ShipEquipmentPanel />
        </TabsContent>
        <TabsContent value="config">
          <ShipRenamePanel />
        </TabsContent>
      </Tabs>
      {activeTab && (
        <div className="flex flex-col gap-separator mt-separator">
          <Button
            variant="ghost"
            size="ui"
            className="text-xs grow shrink-0 border-t-0 justify-between w-full hover:outline-0 focus-visible:outline-0 hover:bg-muted bg-accent-background"
            onClick={() => setActiveTab("")}
          >
            <XIcon className="shrink-0 my-auto text-subtle" />
            Close
            <XIcon className="shrink-0 my-auto text-subtle" />
          </Button>
          <Divider color="secondary" />
          <Divider variant="dashed" className="h-ui-sm text-muted" />
        </div>
      )}
    </>
  )
}

export const PlayerShipPanel = ({ className }: { className?: string }) => {
  return (
    <div className={cn("bg-background", className)}>
      <div className="border-l p-ui-sm bg-subtle-background">
        <PlayerShip />
      </div>
      <PlayerShipTabControls />
    </div>
  )
}
