import { format } from "date-fns"
import { CheckCircleIcon, CircleDashedIcon, CircleIcon, UserIcon } from "@phosphor-icons/react"

import RadialGrad from "@/assets/images/radial-grad-md.png"
import { BlankSlateTile } from "@/components/BlankSlates"
import { DottedTitle } from "@/components/DottedTitle"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import { ShipLogoPopover } from "@/components/ShipLogoPopover"
import useGameStore from "@/stores/game"

import { MovementHistoryPanel } from "./DataTablePanels"
import { RHSPanelContent, RHSSubPanel } from "./RHSPanelContainer"
import { ShipCatalogue } from "./ShipCatalogue"

import { SHIP_DEFINITIONS } from "@/types/ships"

const QuestStepRow = ({
  step,
  isActive,
  isLast,
}: {
  step: QuestStep
  isActive: boolean
  isLast: boolean
}) => {
  const setViewCodec = useGameStore.use.setViewCodec()
  const setActiveModal = useGameStore.use.setActiveModal()

  const hasCodec = !!step.meta?.codec
  const progress =
    step.target_value > 0 ? Math.min(100, (step.current_value / step.target_value) * 100) : 0

  function handleClick() {
    if (!hasCodec) return
    setViewCodec(step.meta.codec!)
    setActiveModal("quest_codec")
  }

  return (
    <div
      className={`flex gap-ui-xs ${hasCodec ? "cursor-pointer hover:bg-accent/30 rounded" : ""}`}
      onClick={handleClick}
    >
      {/* Timeline column */}
      <div className="flex flex-col items-center w-4 shrink-0">
        {step.completed ?
          <CheckCircleIcon weight="fill" className="size-4 text-green-400 shrink-0" />
        : isActive ?
          <CircleDashedIcon weight="bold" className="size-4 text-foreground shrink-0" />
        : <CircleIcon className="size-4 text-subtle-foreground/40 shrink-0" />}
        {!isLast && <div className="w-px flex-1 min-h-2 bg-accent" />}
      </div>
      {/* Step content */}
      <div
        className={`flex flex-col gap-0.5 pb-ui-xs min-w-0 ${step.completed ? "opacity-60" : ""}`}
      >
        <span
          className={`text-xxs uppercase leading-4 ${isActive ? "text-foreground" : "text-subtle-foreground"}`}
        >
          {step.name}
        </span>
        {isActive && !step.completed && step.target_value > 0 && (
          <div className="flex items-center gap-ui-xs">
            <div className="w-full h-1 bg-accent rounded-full overflow-hidden">
              <div
                className="h-full bg-foreground rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xxs text-subtle-foreground tabular-nums shrink-0">
              {step.current_value}/{step.target_value}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

const QuestList = () => {
  const quests = useGameStore.use.quests?.()

  if (!quests || quests.length === 0) {
    return <BlankSlateTile text="No active contracts" />
  }

  return (
    <div className="flex flex-col gap-ui-xs">
      {quests.map((quest) => {
        const allSteps = [
          ...quest.completed_steps,
          ...(quest.current_step ? [quest.current_step] : []),
        ].sort((a, b) => a.step_index - b.step_index)

        return (
          <div
            key={quest.quest_id}
            className="corner-dots p-ui-xs flex flex-col gap-0.5 border border-accent bg-subtle-background"
          >
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-xs font-medium uppercase">{quest.name}</span>
              <span
                className={`text-xxs uppercase ${
                  quest.status === "completed" ? "text-green-400"
                  : quest.status === "failed" ? "text-red-400"
                  : "text-subtle-foreground"
                }`}
              >
                {quest.status}
              </span>
            </div>
            {allSteps.length > 0 && (
              <div className="flex flex-col">
                {allSteps.map((step, i) => (
                  <QuestStepRow
                    key={step.step_index}
                    step={step}
                    isActive={!step.completed && quest.status === "active"}
                    isLast={i === allSteps.length - 1}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export const PlayerPanel = () => {
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()
  const player = useGameStore.use.player?.()
  const corporation = useGameStore.use.corporation?.()
  const ship = useGameStore.use.ship?.()

  return (
    <RHSPanelContent>
      <header className="flex flex-col items-center justify-center pt-ui-sm">
        <figure className="z-10 relative size-21 bg-background p-1 elbow -elbow-offset-4 elbow-size-8 elbow-1 elbow-subtle border border-terminal">
          <div className="h-full flex flex-col items-center justify-center bg-accent shrink-0 text-subtle-background dither-mask-md">
            <UserIcon weight="duotone" className="size-7 text-foreground relative z-10" />
          </div>
        </figure>

        <Card size="sm" className="relative w-full border-x-0 -mt-ui-lg pt-ui-lg overflow-hidden">
          <img
            src={RadialGrad}
            alt=""
            className="absolute -top-32 left-1/2 -translate-x-1/2 opacity-25 select-none"
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
          <CardTitle>Contracts</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-xs">
          <QuestList />
        </CardContent>
      </Card>

      <Card size="sm" className="border-0 border-y">
        <CardHeader className="shrink-0">
          <CardTitle>Movement History</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-row gap-ui-sm">
          <div className="text-xs flex flex-col flex-1">
            <MovementHistoryPanel className="max-h-70" />
          </div>
        </CardContent>
      </Card>

      <RHSSubPanel>
        <ShipCatalogue />
      </RHSSubPanel>
    </RHSPanelContent>
  )
}
