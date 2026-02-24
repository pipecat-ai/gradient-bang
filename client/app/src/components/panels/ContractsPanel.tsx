import { CheckerboardIcon, CheckIcon } from "@phosphor-icons/react"

import { BlankSlateTile } from "@/components/BlankSlates"
import { RHSPanelContent } from "@/components/panels/RHSPanelContainer"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/primitives/Accordion"
import { Badge } from "@/components/primitives/Badge"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Progress } from "@/components/primitives/Progress"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const HEX_PATH = "M8.66 1.5 15.32 5.35V13.05l-6.66 3.85L2 13.05V5.35Z"

const HexCompleted = () => (
  <svg viewBox="0 0 17.32 16.9" className="size-6 shrink-0">
    <path d={HEX_PATH} fill="currentColor" className="text-success-background" />
    <CheckIcon size={8} weight="bold" className="text-success-foreground" x="4.66" y="4.45" />
  </svg>
)

const HexActive = () => (
  <svg viewBox="0 0 17.32 16.9" className="size-6 shrink-0">
    <defs>
      <clipPath id="hex-clip">
        <path d={HEX_PATH} />
      </clipPath>
    </defs>
    <path
      d={HEX_PATH}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      className="text-fuel"
      clipPath="url(#hex-clip)"
    />
  </svg>
)

const HexInactive = () => (
  <svg viewBox="0 0 17.32 16.9" className="size-6 shrink-0">
    <path
      d={HEX_PATH}
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      className="text-subtle-foreground/40"
    />
  </svg>
)

const ContractStepRow = ({
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

  function viewBriefing() {
    setViewCodec(step.meta.codec!)
    setActiveModal("quest_codec")
  }

  return (
    <div className="flex gap-ui-sm">
      {/* Timeline column */}
      <div className="flex flex-col items-center w-6 shrink-0">
        {step.completed ?
          <HexCompleted />
        : isActive ?
          <HexActive />
        : <HexInactive />}
        {!isLast && <div className="w-px flex-1 min-h-3 bg-accent my-0.5" />}
      </div>
      {/* Step content */}
      <div
        className={`flex flex-col gap-0.5 pb-ui-sm min-w-0 flex-1 ${step.completed ? "opacity-60" : ""}`}
      >
        <span
          className={`text-xxs uppercase leading-4 ${isActive ? "text-foreground" : "text-subtle-foreground"}`}
        >
          {step.name}
        </span>
        {isActive && !step.completed && step.target_value > 0 && (
          <div className="flex items-center gap-ui-xs">
            <Progress value={progress} color="fuel" className="h-1" />
            <span className="text-xxs text-subtle-foreground tabular-nums shrink-0">
              {step.current_value}/{step.target_value}
            </span>
          </div>
        )}
        {hasCodec && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              viewBriefing()
            }}
            className={`text-xxs uppercase hover:underline text-left cursor-pointer ${step.completed ? "text-accent" : "text-terminal-foreground"}`}
          >
            View Briefing
          </button>
        )}
      </div>
    </div>
  )
}

export const ContractsPanel = () => {
  const contracts = useGameStore.use.quests?.()
  const sector = useGameStore.use.sector?.()
  const setActiveModal = useGameStore.use.setActiveModal()
  const isMegaPort = !!sector?.port?.mega

  const hasContracts = contracts && contracts.length > 0

  return (
    <RHSPanelContent>
      <Button
        variant="ghost"
        disabled={!isMegaPort}
        onClick={() => setActiveModal("quest_list")}
        className={cn(
          "mx-ui-xs mt-ui-xs text-xxs uppercase w-auto relative",
          isMegaPort
            ? "bg-fuel-background/60 text-fuel-foreground border border-fuel hover:bg-fuel-background/40"
            : "disabled:opacity-100 text-subtle-background after:content-[''] after:absolute after:inset-0 after:bg-stripes-sm after:bg-stripes-accent-background"
        )}
      >
        <CheckerboardIcon weight="bold" className={cn("size-3.5 z-10", isMegaPort ? "text-fuel" : "text-subtle")} />
        <span className={cn("z-10", isMegaPort ? "text-fuel-foreground font-bold" : "text-subtle")}>
          Contract Board
        </span>
      </Button>

      <Card size="sm" className="border-x-0 border-y">
        <CardHeader>
          <CardTitle>Active Contracts</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-xs pr-0!">
          {!hasContracts && <BlankSlateTile text="No active contracts" />}
          {hasContracts && (
            <Accordion
              type="multiple"
              defaultValue={contracts
                .filter((c) => c.status === "active")
                .map((c) => c.quest_id)}
            >
              {contracts.map((contract) => {
                const allSteps = [
                  ...contract.completed_steps,
                  ...(contract.current_step ? [contract.current_step] : []),
                ].sort((a, b) => a.step_index - b.step_index)

                return (
                  <AccordionItem
                    key={contract.quest_id}
                    value={contract.quest_id}
                    className="corner-dots p-ui-xs flex flex-col gap-0.5 border border-accent border-r-0 bg-subtle-background not-last:border-b-0!"
                  >
                    <AccordionTrigger className="p-0 rounded-none hover:no-underline">
                      <div className="flex items-center justify-between flex-1">
                        <span className="text-xs font-medium uppercase">{contract.name}</span>
                        <Badge
                          size="sm"
                          variant={
                            contract.status === "completed" ? "success"
                            : contract.status === "failed" ?
                              "warning"
                            : "highlight"
                          }
                          className="text-xxs py-0.5"
                        >
                          {contract.status}
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-0">
                      {contract.meta.giver && (
                        <span className="text-xxs text-subtle-foreground uppercase">
                          Issued by: {contract.meta.giver}
                        </span>
                      )}
                      {allSteps.length > 0 && (
                        <div className="flex flex-col">
                          {allSteps.map((step, i) => (
                            <ContractStepRow
                              key={step.step_index}
                              step={step}
                              isActive={!step.completed && contract.status === "active"}
                              isLast={i === allSteps.length - 1}
                            />
                          ))}
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                )
              })}
            </Accordion>
          )}
        </CardContent>
      </Card>
    </RHSPanelContent>
  )
}
