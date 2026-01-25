import { AnimatePresence, motion } from "motion/react"
import { CircleNotchIcon, UserIcon } from "@phosphor-icons/react"

import { CurrentSectorIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { PopoverHelper } from "../PopoverHelper"
import { Badge } from "../primitives/Badge"
import { DotDivider } from "../primitives/DotDivider"

const ShipBlankSlate = ({
  fetching,
  children,
}: {
  fetching?: boolean
  children?: React.ReactNode
}) => {
  return (
    <div className="bg-[linear-gradient(to_right,transparent_0%,var(--subtle-background)_20%,var(--subtle-background)_80%,transparent_100%)] text-subtle text-xs uppercase font-medium leading-none py-2">
      <div className="flex flex-row gap-3 items-center justify-center">
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
    <div className="uppercase shrink-0 py-3 pb-3.5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-row gap-2 items-center">
          <div className="text-sm uppercase text-white font-semibold">{ship.ship_name}</div>
          <div className="text-xs text-subtle-foreground">{ship.ship_type.replace("_", " ")}</div>
        </div>
        <div className="text-sm text-subtle-foreground flex flex-row gap-2 items-center">
          <Badge variant="secondary" border="elbow" size="sm" className="font-semibold">
            <CurrentSectorIcon weight="duotone" className="size-4" />
            <span className="text-subtle-foreground">Sector</span>
            <span className="min-w-6 text-right">{ship.sector}</span>
          </Badge>
          <DotDivider />
          <Badge
            variant={activeTask ? "success" : "secondary"}
            border="bracket"
            size="sm"
            className="font-semibold w-24"
          >
            {activeTask ?
              <>
                <CircleNotchIcon weight="duotone" size={16} className="animate-spin" /> Active
              </>
            : <span className="text-muted-foreground">Inactive</span>}
          </Badge>
          <div
            className={cn(
              "flex flex-row gap-1 items-center text-xs",
              activeTask ? "gap-1.5 text-white" : "text-accent-foreground"
            )}
          >
            <UserIcon weight="duotone" className="size-4" />
            {activeTask ? activeTask.actor_character_name : "---"}
          </div>
        </div>
      </div>
    </div>
  )
}

const PlayerShipPanelContent = ({
  ships,
  className,
}: {
  ships: ShipSelf[] | undefined
  className?: string
}) => {
  return (
    <motion.div
      layout
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className={cn("bg-card border", className)}
    >
      <AnimatePresence mode="wait">
        {!ships ?
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="px-2"
          >
            <ShipBlankSlate fetching={ships === undefined} />
          </motion.div>
        : ships.filter((ship) => ship.owner_type === "corporation").length === 0 ?
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="px-2"
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
              <div className="w-3 dashed-bg-vertical dashed-bg-accent ml-panel-gap"></div>
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

export const PlayerShipPanel = ({ className }: { className?: string }) => {
  const shipsState = useGameStore((state) => state.ships)

  const ships = shipsState.data

  return <PlayerShipPanelContent ships={ships} className={className} />
}
