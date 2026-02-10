import { useState } from "react"

import { AnimatePresence, motion } from "motion/react"

import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

import { Button } from "../primitives/Button"
import { Input } from "../primitives/Input"
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../primitives/Select"
import { SliderControl } from "../primitives/SliderControl"
import { AttackActionLG } from "../svg/AttackActionLG"
import { ChevronSM } from "../svg/ChevronSM"
import { FleeActionLG } from "../svg/FleeActionLG"
import { ShieldActionLG } from "../svg/ShieldActionLG"

export interface CombatActionOptionsProps {
  round: number
  onSelectedAction: (action: CombatActionType) => void
  attackCommit: string | null
  onAttackCommit: (commit: string) => void
  selectedTargetKey: string
  onSelectedTargetKey: (key: string) => void
  payTollAmount: number
  onPayToll: () => void
  maxAttackCommit: number
  pendingReceipt: CombatActionReceipt | null
  attackTargets: CombatAttackTargetOption[]
  selectedAttackTarget: CombatAttackTargetOption | null
  canAttack: boolean
  canBrace: boolean
  canPayToll: boolean
  error: string | null
  receipt: CombatActionReceipt | null | undefined
}
const ROUND_DEAL_DELAY_MS = 400

const actionButtonCX =
  "flex-1 flex flex-col py-5 justify-between bg-transparent text-sm uppercase font-bold text-foreground h-full z-20"
const activeActionButtonCX = "text-terminal-foreground scale-105"
const inactiveActionButtonCX = "opacity-30 scale-95"

const actionButtonHelperCX =
  "text-xxs uppercase font-normal text-subtle-foreground bg-background/40 px-1 py-px"
const actionButtonLabelCX = "flex-1 flex flex-col gap-1 items-center"

const actionCardCX =
  "group select-none flex-1 flex relative origin-bottom transition-transform duration-500 focus-outline"
const actionCardActiveCX = "scale-105 combat-action-active focus-visible:animate-outline-pulse"
const actionCardInactiveCX = "scale-95 combat-action-inactive"

const navVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.15,
      delayChildren: ROUND_DEAL_DELAY_MS / 1000,
    },
  },
  exit: { transition: { staggerChildren: 0.05, staggerDirection: -1 } },
}

const cardVariants = {
  hidden: { opacity: 0, y: 40 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      y: { type: "spring" as const, stiffness: 400, damping: 24 },
      opacity: { duration: 0.6, ease: "easeOut" as const },
    },
  },
  exit: {
    opacity: 0,
    y: 40,
    transition: { type: "spring" as const, stiffness: 300, damping: 20 },
  },
}

export const CombatActionOptions = (props: CombatActionOptionsProps) => {
  const [actionSelected, setActionSelected] = useState<CombatActionType | null>(null)
  const [selectedAttackTarget, setSelectedAttackTarget] = useState<CombatAttackTargetOption | null>(
    null
  )
  const [selectedAttackCommit, setSelectedAttackCommit] = useState<string>(
    props.attackCommit ?? "1"
  )
  const [attackCommitError, setAttackCommitError] = useState<string | null>(null)
  const [attackPopoverOpen, setAttackPopoverOpen] = useState(false)
  const [showCards, setShowCards] = useState(true)
  const [lastRound, setLastRound] = useState(props.round)

  // Reset selection when a new round starts
  if (props.round !== lastRound) {
    setLastRound(props.round)
    setShowCards(true)
    setActionSelected(null)
  }

  /*
  const handleAttackCommit = () => {
    const commit = Number.parseInt(selectedAttackCommit, 10)
    if (Number.isFinite(commit) && commit >= 1 && commit <= props.maxAttackCommit) {
      props.onAttackCommit(commit.toString())
    } else {
      setAttackCommitError("Commit must be between 1 and " + props.maxAttackCommit.toString())
    }
    if (!selectedAttackTarget?.id) {
      setAttackCommitError("No target selected")
    }
    if (attackCommitError) {
      return
    }

    setAttackPopoverOpen(false)

    props.onAttackCommit(commit.toString())
    props.onSelectedTargetKey(selectedAttackTarget?.key ?? "")

    setActionSelected("attack")
  }*/

  const handleSubmitAction = () => {
    if (!actionSelected) return
    props.onSelectedAction(actionSelected)

    // Animate cards out
    setShowCards(false)
    setAttackCommitError(null)
    setSelectedAttackTarget(null)
    setSelectedAttackCommit("")
    setAttackPopoverOpen(false)
  }

  const getActionCardCX = (action: CombatActionType) =>
    actionSelected === null ? ""
    : actionSelected === action ? actionCardActiveCX
    : actionCardInactiveCX

  const getActionButtonCX = (action: CombatActionType) =>
    actionSelected === null ? ""
    : actionSelected === action ? activeActionButtonCX
    : inactiveActionButtonCX

  return (
    <div className="flex flex-col gap-ui-xs py-ui-sm bg-linear-to-t from-background from-30% to-background/0">
      <div className="flex flex-row gap-ui-sm h-32 px-ui-sm">
        <div
          className={cn(
            "inline-flex items-center gap-0.5",
            showCards ?
              "animate-in slide-in-from-left duration-500 fade-in-1"
            : "animate-out slide-out-to-left duration-500 fade-out-0 fill-mode-forwards"
          )}
        >
          <ChevronSM className="size-4 text-foreground -rotate-90" />
          <ChevronSM className="size-4 text-foreground -rotate-90" />
          <ChevronSM className="size-4 text-foreground -rotate-90" />
        </div>
        <div className="flex-1 flex">
          <AnimatePresence mode="wait">
            {showCards && (
              <motion.nav
                key={props.round}
                className="flex-1 flex flex-row z-20 w-fit gap-ui-xs"
                initial="hidden"
                animate="visible"
                exit="exit"
                variants={navVariants}
              >
                <motion.div
                  className={cn(actionCardCX, getActionCardCX("brace"))}
                  variants={cardVariants}
                >
                  <Button
                    variant="bland"
                    disabled={!props.canBrace}
                    className={cn(actionButtonCX, getActionButtonCX("brace"))}
                    onClick={() => setActionSelected("brace")}
                    tabIndex={0}
                  >
                    <label className={actionButtonLabelCX}>
                      <ShieldActionLG className="size-[46px]" />
                      Brace
                    </label>
                    <small className={actionButtonHelperCX}>Boost mitigation</small>
                  </Button>
                  <div className="combat-action" />
                </motion.div>
                <motion.div
                  className={cn(actionCardCX, getActionCardCX("attack"))}
                  variants={cardVariants}
                >
                  <Popover open={attackPopoverOpen} onOpenChange={setAttackPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="bland"
                        disabled={!props.canAttack}
                        className={cn(actionButtonCX, getActionButtonCX("attack"))}
                        onClick={() => setActionSelected("attack")}
                        tabIndex={0}
                      >
                        <label className={actionButtonLabelCX}>
                          <AttackActionLG className="size-[44px]" />
                          Attack
                        </label>
                        <small className={actionButtonHelperCX}>Deploy fighters at target</small>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      side="top"
                      className="shadow-lg shadow-background/20 w-sm border-white"
                    >
                      <small className="text-xs uppercase text-foreground">Target ship</small>
                      <Select
                        value={selectedAttackTarget?.key ?? ""}
                        onValueChange={(value) =>
                          setSelectedAttackTarget(
                            props.attackTargets.find((target) => target.key === value) ?? null
                          )
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a target" />
                        </SelectTrigger>
                        <SelectContent>
                          {props.attackTargets.map((target) => (
                            <SelectItem key={target.key} value={target.key}>
                              {target.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <small className="text-xs uppercase text-foreground">
                        Number of fighters to commit
                      </small>
                      <div className="flex flex-row gap-ui-xs">
                        <SliderControl
                          min={1}
                          max={props.maxAttackCommit}
                          step={1}
                          size="lg"
                          defaultValue={[selectedAttackCommit as unknown as number]}
                          onValueChange={(value) => setSelectedAttackCommit(value[0].toString())}
                          className="flex-1"
                        />
                        <Input
                          type="number"
                          min={1}
                          max={props.maxAttackCommit}
                          value={selectedAttackCommit}
                          onChange={(event) => setSelectedAttackCommit(event.target.value)}
                          className="w-20 text-center appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
                        />
                      </div>
                      {attackCommitError ?
                        <div className="text-xxs uppercase text-destructive">
                          {attackCommitError}
                        </div>
                      : null}
                    </PopoverContent>
                  </Popover>
                  <div className="combat-action" />
                </motion.div>
                <motion.div
                  className={cn(actionCardCX, getActionCardCX("flee"))}
                  variants={cardVariants}
                >
                  <Button
                    variant="bland"
                    className={cn(actionButtonCX, getActionButtonCX("flee"))}
                    onClick={() => setActionSelected("flee")}
                    tabIndex={0}
                  >
                    <label className={actionButtonLabelCX}>
                      <FleeActionLG className="size-[44px]" />
                      Flee
                    </label>
                    <small className={actionButtonHelperCX}>Flee to adjacent sector</small>
                  </Button>
                  <div className="combat-action" />
                </motion.div>
                {props.canPayToll && (
                  <motion.div
                    className={cn(actionCardCX, getActionCardCX("pay"))}
                    variants={cardVariants}
                  >
                    <Button
                      variant="bland"
                      className={cn(actionButtonCX, getActionButtonCX("pay"))}
                      onClick={() => setActionSelected("pay")}
                      tabIndex={0}
                    >
                      <label className={actionButtonLabelCX}>
                        <ShieldActionLG className="size-[44px]" />
                        Pay {formatCurrency(props.payTollAmount)}
                      </label>

                      <small className={actionButtonHelperCX}>Pay toll and proceed</small>
                    </Button>
                    <div className="combat-action" />
                  </motion.div>
                )}
              </motion.nav>
            )}
          </AnimatePresence>
        </div>
        <div
          className={cn(
            "inline-flex items-center gap-0.5 ",
            showCards ?
              "animate-in slide-in-from-right duration-500 fade-in-1"
            : "animate-out slide-out-to-right duration-500 fade-out-0 fill-mode-forwards"
          )}
        >
          <ChevronSM className="size-4 text-foreground rotate-90" />
          <ChevronSM className="size-4 text-foreground rotate-90" />
          <ChevronSM className="size-4 text-foreground rotate-90" />
        </div>
      </div>
      <footer className="flex-1 flex items-center justify-center gap-ui-sm z-50 bg-background">
        <div className="flex-1 flex dashed-bg-vertical dashed-bg-accent h-full" />
        <Button
          onClick={handleSubmitAction}
          size="lg"
          disabled={
            !actionSelected ||
            !showCards ||
            (actionSelected === "attack" && (!selectedAttackTarget || !selectedAttackCommit))
          }
          className="w-sm mx-auto"
          tabIndex={0}
        >
          Commit
          <span className="font-light">
            {actionSelected === "attack" ?
              !selectedAttackTarget ?
                "No target selected"
              : !selectedAttackCommit ?
                "No commit selected"
              : actionSelected
            : actionSelected}
          </span>
        </Button>
        <div className="flex-1 flex dashed-bg-vertical dashed-bg-accent h-full" />
      </footer>
    </div>
  )
}
