import { useEffect, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { ArrowUpIcon, CircleNotchIcon, ShieldIcon, UserIcon } from "@phosphor-icons/react"

import { PlayerShipCombatMarker } from "@/components/PlayerShipCombatMarker"
import { ShipCardStat } from "@/components/ShipCardStat"
import { CreditsIcon, CurrentSectorIcon, FighterIcon, FuelIcon } from "@/icons"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { isShipInCombat } from "@/utils/combat"
import { formatCurrency } from "@/utils/formatting"
import { shipTypeVerbose } from "@/utils/game"
import { cn } from "@/utils/tailwind"

import { PlayerFightersBadge, PlayerShieldsBadge, PlayerShipFuelBadge } from "../PlayerShipBadges"
import { PlayerShipCargo } from "../PlayerShipCargo"
import { PopoverHelper } from "../PopoverHelper"
import { Badge } from "../primitives/Badge"
import { Button } from "../primitives/Button"
import { DotDivider } from "../primitives/DotDivider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../primitives/Tabs"
import { ShipEquipmentPanel } from "./ShipEquipmentPanel"
import { ShipStrategiesPanel } from "./ShipStrategiesPanel"

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
  const isBusy = !!(activeTask || ship.current_task_id)
  const actorName = activeTask?.actor_character_name ?? ship.current_task_actor_name
  const isInCombat = useGameStore((state) => isShipInCombat(state, ship.ship_id))

  useEffect(() => {
    let prev = isShipInCombat(useGameStore.getState(), ship.ship_id)
    return useGameStore.subscribe((state) => {
      const next = isShipInCombat(state, ship.ship_id)
      if (next && !prev) useAudioStore.getState().playSound("combatChime1")
      prev = next
    })
  }, [ship.ship_id])

  return (
    <div className="relative isolate uppercase shrink-0 pl-ui-sm py-2 pb-3.5 flex flex-row gap-2 items-center justify-between">
      <AnimatePresence>
        {isInCombat && (
          <PlayerShipCombatMarker className="absolute -left-3 top-0 h-full w-32 z-0 text-warning-background pointer-events-none" />
        )}
      </AnimatePresence>
      <div className="relative z-10 flex flex-col gap-2 flex-1 min-w-0">
        <div className="flex flex-row gap-2 items-center">
          <div className="text-sm uppercase text-white font-semibold">{ship.ship_name}</div>
          <div className="text-xxs text-subtle-foreground">{shipTypeVerbose(ship.ship_type)}</div>
        </div>
        <div className="text-sm text-subtle-foreground flex flex-row gap-ui-xxs items-center min-w-0">
          <Badge variant="secondary" border="elbow" size="sm" className="font-semibold bg-white/7">
            <CurrentSectorIcon weight="duotone" className="size-4" />
            <span className="min-w-9 text-right text-muted-foreground">{ship.sector}</span>
          </Badge>
          <Badge variant="secondary" border="elbow" size="sm" className="font-semibold bg-white/7">
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
          {isInCombat ?
            <Badge
              variant="warning"
              border="elbow"
              size="sm"
              className="animate-pulse font-semibold w-20 border-warning/20 elbow-offset-1 elbow-warning"
            >
              In Combat
            </Badge>
          : <>
              <Badge
                variant={isBusy ? "success" : "secondary"}
                border="bracket"
                size="sm"
                className="font-semibold w-20 "
              >
                {isBusy ?
                  <>
                    <CircleNotchIcon weight="duotone" size={16} className="animate-spin" /> Active
                  </>
                : <span className="text-muted-foreground">Inactive</span>}
              </Badge>
              <div
                className={cn(
                  "flex flex-row gap-1 items-center text-xs truncate flex-1 min-w-0 overflow-hidden w-full",
                  isBusy ? "gap-1.5 text-white" : "text-accent-foreground"
                )}
              >
                <UserIcon weight="duotone" className="size-4 shrink-0" />
                <span className="truncate">{actorName ?? "---"}</span>
              </div>
            </>
          }
        </div>
      </div>
      <dl className="relative z-10 grid grid-cols-[auto_1fr] text-xxs gap-y-px my-auto">
        <ShipCardStat Icon={FuelIcon} value={ship.warp_power} />
        <ShipCardStat Icon={FighterIcon} value={ship.fighters} />
        <ShipCardStat Icon={ShieldIcon} value={ship.shields} />
      </dl>
    </div>
  )
}

// Blink keyframes for destroyed ship animation (~5s blink in-place)
const BLINK_STEPS = 10
const blinkOpacity = Array.from({ length: BLINK_STEPS }, (_, i) => (i % 2 === 0 ? 1 : 0.15))

// Three-blink attention keyframes used when a ship enters combat.
const combatBlinkOpacity = [1, 0.15, 1, 0.15, 1, 0.15, 1]
const COMBAT_BLINK_DURATION_S = 1.0

const exitTransition = {
  height: { duration: 0.3, ease: "easeInOut" as const },
  x: { duration: 0.25, delay: 0.3, ease: "easeOut" as const },
  opacity: { duration: 0.2, delay: 0.3 },
}

const PlayerShipsPanelContent = ({ className }: { className?: string }) => {
  const shipsState = useGameStore.use.ships()
  const ships = shipsState.data
  const destroyedShips = useGameStore.use.destroyedShips()
  const destroyingShipIds = useGameStore.use.destroyingShipIds()
  const clearDestroyingShipId = useGameStore.use.clearDestroyingShipId()

  // Active corp ships + ships mid-destruction animation (from destroyedShips)
  const activeCorpShips = ships?.filter((s) => s.owner_type === "corporation") ?? []
  const animatingShips = destroyedShips.filter(
    (s) => s.owner_type === "corporation" && destroyingShipIds.includes(s.ship_id)
  )
  const corpShips = [...animatingShips, ...activeCorpShips]

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevActiveCountRef = useRef(activeCorpShips.length)
  const prevDestroyingIdsRef = useRef<string[]>(destroyingShipIds)
  const [combatEnteredShipIds, setCombatEnteredShipIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (activeCorpShips.length > prevActiveCountRef.current && corpShips.length > 3) {
      const timer = setTimeout(() => {
        const el = scrollRef.current
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
      }, 350)
      prevActiveCountRef.current = activeCorpShips.length
      return () => clearTimeout(timer)
    }
    prevActiveCountRef.current = activeCorpShips.length
  }, [activeCorpShips.length, corpShips.length])

  useEffect(() => {
    const newId = destroyingShipIds.find((id) => !prevDestroyingIdsRef.current.includes(id))
    prevDestroyingIdsRef.current = destroyingShipIds
    if (!newId || corpShips.length <= 3) return
    const el = scrollRef.current?.querySelector(`[data-ship-id="${newId}"]`)
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [destroyingShipIds, corpShips.length])

  useEffect(() => {
    const getParticipantIds = (state: ReturnType<typeof useGameStore.getState>) => {
      const ids = new Set<string>()
      for (const p of state.activeCombatSession?.participants ?? []) {
        if (p.id) ids.add(p.id)
      }
      for (const session of Object.values(state.observedCombatSessions)) {
        for (const p of session.participants) {
          if (p.id) ids.add(p.id)
        }
      }
      return ids
    }
    let prevIds = getParticipantIds(useGameStore.getState())
    return useGameStore.subscribe((state) => {
      const currentIds = getParticipantIds(state)
      const corpShipIds = new Set(
        (state.ships.data ?? []).filter((s) => s.owner_type === "corporation").map((s) => s.ship_id)
      )
      const totalCorpCount = corpShipIds.size
      for (const id of currentIds) {
        if (prevIds.has(id) || !corpShipIds.has(id)) continue
        if (totalCorpCount > 3) {
          const el = scrollRef.current?.querySelector(`[data-ship-id="${id}"]`)
          el?.scrollIntoView({ behavior: "smooth", block: "nearest" })
        }
        setCombatEnteredShipIds((prev) => new Set(prev).add(id))
        setTimeout(() => {
          setCombatEnteredShipIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        }, COMBAT_BLINK_DURATION_S * 1000)
      }
      prevIds = currentIds
    })
  }, [])

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
        : corpShips.length === 0 ?
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <ShipBlankSlate>
              <span className="flex flex-row gap-2 items-center justify-center">
                No corporation ships{" "}
                <PopoverHelper
                  className="text-subtle-foreground"
                  title="Requires corporation"
                  description="Grow your fleet by founding a corporation and purchasing new vessels. Ask voice agent for more info."
                />
              </span>
            </ShipBlankSlate>
          </motion.div>
        : <motion.div
            key="ships"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {corpShips.length > 0 && (
              <div className="relative flex flex-row gap-panel-gap px-0 py-panel-gap shrink-0">
                <div className="absolute inset-0 bottom-0 z-10 dither-mask-sm dither-mask-invert text-card pointer-events-none" />
                <div className="w-2 dashed-bg-vertical-tight dashed-bg-muted ml-panel-gap"></div>
                <div
                  ref={scrollRef}
                  className="bg-subtle-background border border-r-0 flex-1 overflow-y-scroll overflow-x-hidden max-h-40 @tall-lg:max-h-59 tall-lg:max-h-[23rem] pb-12"
                >
                  <AnimatePresence initial={false}>
                    {corpShips.map((ship) => {
                      const isDestroying = destroyingShipIds.includes(ship.ship_id)
                      const isCombatBlinking = combatEnteredShipIds.has(ship.ship_id)
                      return (
                        <motion.div
                          key={ship.ship_id}
                          data-ship-id={ship.ship_id}
                          initial={{ height: 0, x: 40, opacity: 0 }}
                          animate={
                            isDestroying ?
                              {
                                height: "auto",
                                x: 0,
                                opacity: [...blinkOpacity, 0],
                                transition: {
                                  opacity: { duration: 5.5, ease: "linear" as const },
                                },
                              }
                            : isCombatBlinking ?
                              {
                                height: "auto",
                                x: 0,
                                opacity: combatBlinkOpacity,
                                transition: {
                                  opacity: {
                                    duration: COMBAT_BLINK_DURATION_S,
                                    ease: "linear" as const,
                                  },
                                },
                              }
                            : { height: "auto", x: 0, opacity: 1 }
                          }
                          exit={{
                            height: 0,
                            x: 40,
                            opacity: 0,
                            transition: exitTransition,
                          }}
                          onAnimationComplete={() => {
                            if (isDestroying) {
                              clearDestroyingShipId(ship.ship_id)
                            }
                          }}
                          transition={exitTransition}
                          className="relative overflow-hidden after:content-[''] after:absolute after:bottom-0 after:left-ui-sm after:right-0 after:h-px after:bg-white/20 last:after:hidden"
                        >
                          <ShipCard ship={ship} />
                          <motion.div
                            className="absolute inset-0 cross-lines-destructive cross-lines-offset-5 flex items-center justify-center bg-card/50"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: isDestroying ? 1 : 0 }}
                            transition={{ duration: 0.3 }}
                          >
                            <span className="relative z-10 outline-1 outline-destructive text-xs uppercase font-bold bg-destructive-background text-destructive-foreground px-2 py-1">
                              Destroyed
                            </span>
                          </motion.div>
                        </motion.div>
                      )
                    })}
                  </AnimatePresence>
                </div>
              </div>
            )}
          </motion.div>
        }
      </AnimatePresence>
    </motion.div>
  )
}

const PlayerShip = () => {
  const ship = useGameStore((state) => state.ship)
  return (
    <div id="ship-card" className="flex flex-col gap-2">
      <div className="flex flex-row gap-ui-sm items-center">
        <div className="uppercase text-white font-semibold">{ship?.ship_name ?? "---"}</div>
        <div className="text-xxs uppercase text-subtle-foreground">
          {shipTypeVerbose(ship?.ship_type) ?? "---"}
        </div>
        <div className="flex-1 h-3 dashed-bg-horizontal dashed-bg-accent"></div>
      </div>
      <div id="ship-vitals" className="flex flex-row items-center select-none gap-1">
        <div id="ship-fuel" className="flex-1">
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
  const activeTab = useGameStore.use.playerShipTab()
  const setPlayerShipTab = useGameStore.use.setPlayerShipTab()

  const handleTabClick = (value: PlayerShipTab) => {
    setPlayerShipTab(activeTab === value ? null : value)
  }

  return (
    <>
      <Tabs value={activeTab ?? ""} activationMode="manual">
        <TabsList className="border-l select-none">
          <TabsTrigger
            id="player-ship-tab-ships"
            value="ships"
            onClick={() => handleTabClick("ships")}
          >
            Ships
          </TabsTrigger>
          <TabsTrigger
            id="player-ship-tab-cargo"
            value="cargo"
            onClick={() => handleTabClick("cargo")}
          >
            Cargo
          </TabsTrigger>
          <TabsTrigger
            id="player-ship-tab-modules"
            value="modules"
            onClick={() => handleTabClick("modules")}
          >
            Equipment
          </TabsTrigger>
          <TabsTrigger
            id="player-ship-tab-strategy"
            value="strategy"
            className="border-0"
            onClick={() => handleTabClick("strategy")}
          >
            Strategy
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
        <TabsContent value="strategy">
          <ShipStrategiesPanel />
        </TabsContent>
      </Tabs>
      {activeTab && (
        <div className="flex flex-col gap-separator mt-separator">
          <Button
            variant="ghost"
            size="ui"
            className="text-xs grow shrink-0 border-t-0 justify-between w-full outline-0 hover:outline-0 focus-visible:outline-0 hover:bg-muted bg-subtle-background"
            onClick={() => setPlayerShipTab(null)}
          >
            <ArrowUpIcon size={12} className="shrink-0 my-auto text-subtle" />
            Hide
            <ArrowUpIcon size={12} className="shrink-0 my-auto text-subtle" />
          </Button>
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
