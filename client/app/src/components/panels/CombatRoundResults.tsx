import { useMemo } from "react"

import { motion } from "motion/react"

import { cn } from "@/utils/tailwind"

import { CombatFighterTile, CombatShieldTile } from "../CombatTiles"
import { DottedTitle } from "../DottedTitle"
import { Card, CardContent } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { ScrollArea } from "../primitives/ScrollArea"

// -- Tone utilities ----------------------------------------------------------

type StatTone =
  | "accent-foreground"
  | "destructive"
  | "success"
  | "warning"
  | "terminal"
  | "fuel"
  | "white"

/** Static map so Tailwind JIT can detect every class at build time. */
const toneClass: Record<StatTone, string> = {
  "accent-foreground": "text-accent-foreground",
  destructive: "text-destructive",
  success: "text-success",
  warning: "text-warning",
  terminal: "text-terminal",
  fuel: "text-fuel",
  white: "text-white",
}

// -- Stat item type ----------------------------------------------------------

type StatItem = {
  label: string
  value: string | number
  help: string
  tone: StatTone
}

// -- Stat builders -----------------------------------------------------------

function buildFighterStats(round: CombatPersonalRoundResult): StatItem[] {
  const totalLosses = round.offensiveLosses + round.defensiveLosses

  return [
    {
      label: "Successful Hits",
      value: round.hits,
      help: "Hits your committed fighters landed on the target",
      tone: round.hits > 0 ? "terminal" : "warning",
    },
    {
      label: "Offensive Fighter Losses",
      value: round.offensiveLosses,
      help: "Your fighters lost while attacking (failed attack rolls)",
      tone: round.offensiveLosses > 0 ? "destructive" : "accent-foreground",
    },
    {
      label: "Defensive Fighter Losses",
      value: round.defensiveLosses,
      help: "Your fighters destroyed by incoming enemy attacks",
      tone: round.defensiveLosses > 0 ? "destructive" : "accent-foreground",
    },
    {
      label: "Total Fighter Losses",
      value: totalLosses,
      help: "Combined offensive and defensive fighter losses this round",
      tone: totalLosses > 0 ? "destructive" : "accent-foreground",
    },
    {
      label: "Fighters Remaining",
      value: round.fightersRemaining ?? "—",
      help: "Your total fighters left after this round resolved",
      tone:
        round.fightersRemaining != null && round.fightersRemaining <= 10
          ? "warning"
          : "white",
    },
  ]
}

function buildShieldStats(round: CombatPersonalRoundResult): StatItem[] {
  const incomingPressure = round.defensiveLosses + round.shieldLoss

  const stats: StatItem[] = [
    {
      label: "Incoming Pressure",
      value: incomingPressure,
      help: "Incoming damage pressure (defensive losses plus shield loss)",
      tone: incomingPressure > 0 ? "destructive" : "accent-foreground",
    },
    {
      label: "Shield Loss",
      value: round.shieldLoss,
      help: "Shield points stripped this round by incoming pressure",
      tone: round.shieldLoss > 0 ? "destructive" : "accent-foreground",
    },
    {
      label: "Shields Remaining",
      value: round.shieldsRemaining ?? "—",
      help: "Shield points left after this round resolved",
      tone:
        round.shieldsRemaining != null && round.shieldsRemaining <= 10
          ? "warning"
          : "white",
    },
    {
      label: "Attack Target",
      value: round.target ?? "None",
      help: "Participant you targeted for attack this round",
      tone: "accent-foreground",
    },
  ]

  if (typeof round.fleeSuccess === "boolean") {
    stats.push({
      label: "Flee Attempt",
      value: round.fleeSuccess ? "Success" : "Failed",
      help: "Whether your flee attempt succeeded this round",
      tone: round.fleeSuccess ? "terminal" : "warning",
    })
  }

  return stats
}

// -- Stat tile ---------------------------------------------------------------

const CombatStatTile = ({
  rtl,
  label,
  value,
  help,
  tone = "accent-foreground",
}: {
  rtl: boolean
  label: string
  value: string | number
  help: string
  tone?: StatTone
}) => (
  <div
    className={cn(
      "p-ui-sm border border-accent flex flex-row gap-ui-xs bg-subtle-background",
      rtl ? "mr-ui-xs" : "ml-ui-xs",
    )}
  >
    <div className={cn("pt-ui-xs", rtl ? "order-last" : "order-first")}>
      <Divider className="w-6 bg-subtle" />
    </div>
    <div
      className={cn(
        "flex-1 flex flex-col gap-0.5",
        rtl ? "text-right" : "text-left",
      )}
    >
      <div className="text-xs uppercase text-foreground font-bold">{label}</div>
      <div className={cn("text-md uppercase", toneClass[tone])}>{value}</div>
      <div className="text-xxs uppercase text-subtle-foreground">{help}</div>
    </div>
  </div>
)

// -- Variant config ----------------------------------------------------------

const variantConfig = {
  fighter: {
    title: "Fighter Attrition",
    Icon: CombatFighterTile,
    rtl: false,
    buildStats: buildFighterStats,
  },
  shield: {
    title: "Shield Pressure",
    Icon: CombatShieldTile,
    rtl: true,
    buildStats: buildShieldStats,
  },
} as const

// -- Main panel component ----------------------------------------------------

type CombatRoundResultsPanelProps = {
  round: CombatPersonalRoundResult | null
  variant: "fighter" | "shield"
}

const CombatRoundResultsPanel = ({
  round,
  variant,
}: CombatRoundResultsPanelProps) => {
  const { title, Icon, rtl, buildStats } = variantConfig[variant]

  const stats = useMemo(
    () => (round ? buildStats(round) : []),
    [round, buildStats],
  )

  const animateX = rtl ? 16 : -16

  return (
    <Card
      size="none"
      className="relative border-0 min-h-0 h-full flex flex-row bg-transparent"
    >
      <div
        className={cn(
          "w-6 absolute z-20 inset-y-9 bottom-ui-sm",
          rtl ? "right-0" : "left-0",
        )}
      >
        <Icon />
      </div>

      <CardContent
        className={cn(
          "combat-tile flex-1 flex flex-col gap-ui-xs",
          rtl ? "mr-2.5" : "ml-2.5",
          round ? "bg-card" : "bg-card/30",
        )}
      >
        <DottedTitle
          title={title}
          textColor="text-foreground"
          className="m-panel-gap mb-0"
        />

        <div className="relative h-full flex-1 min-h-0">
          <div className="absolute inset-0">
            <div className="absolute inset-0 bottom-0 z-10 dither-mask-sm dither-mask-invert text-card pointer-events-none" />
            <ScrollArea className="h-full z-0">
              {stats.length > 0 && (
                <div className="flex flex-col gap-ui-xxs my-panel-gap mb-10">
                  {stats.map(({ label, value, help, tone }, i) => (
                    <motion.div
                      key={label}
                      initial={{ opacity: 0, x: animateX }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{
                        delay: i * 0.05,
                        type: "spring",
                        stiffness: 400,
                        damping: 30,
                      }}
                    >
                      <CombatStatTile
                        rtl={rtl}
                        label={label}
                        value={value}
                        help={help}
                        tone={tone}
                      />
                    </motion.div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// -- Backward-compatible named exports ---------------------------------------

export const CombatRoundFighterResults = ({
  round,
}: {
  round: CombatPersonalRoundResult | null
}) => <CombatRoundResultsPanel round={round} variant="fighter" />

export const CombatRoundShieldResults = ({
  round,
}: {
  round: CombatPersonalRoundResult | null
}) => <CombatRoundResultsPanel round={round} variant="shield" />
