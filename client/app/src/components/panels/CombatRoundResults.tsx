import { motion } from "motion/react"

import { cn } from "@/utils/tailwind"

import { CombatFighterTile, CombatShieldTile } from "../CombatTiles"
import { DottedTitle } from "../DottedTitle"
import { Card, CardContent } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { ScrollArea } from "../primitives/ScrollArea"

type StatTone =
  | "accent-foreground"
  | "destructive"
  | "success"
  | "warning"
  | "terminal"
  | "fuel"
  | "white"

const CombatStatTile = ({
  rtl = false,
  label,
  value,
  help,
  tone = "accent-foreground",
}: {
  rtl?: boolean
  label: string
  value: string | number
  help: string
  tone?: StatTone
}) => {
  return (
    <div
      className={cn(
        "p-ui-sm border border-accent flex flex-row gap-ui-xs bg-subtle-background",
        rtl ? "mr-ui-xs" : "ml-ui-xs"
      )}
    >
      <div className={cn("pt-ui-xs", rtl ? "order-last" : "order-first")}>
        <Divider className="w-6 bg-subtle" />
      </div>
      <div className={cn("flex-1 flex flex-col gap-0.5", rtl ? "text-right" : "text-left")}>
        <div className="text-xs uppercase text-foreground font-bold">{label}</div>
        <div className={cn("text-md uppercase text-foreground", `text-${tone}`)}>{value}</div>
        <div className="text-xxs uppercase text-subtle-foreground">{help}</div>
      </div>
    </div>
  )
}

export const CombatRoundFighterResults = ({
  round,
}: {
  round: CombatPersonalRoundResult | null
}) => {
  const totalFighterLosses = (round?.offensiveLosses ?? 0) + (round?.defensiveLosses ?? 0)

  return (
    <Card size="none" className="relative border-0 min-h-0 h-full flex flex-row bg-transparent">
      <div className="w-6 absolute left-0 z-20 inset-y-9 bottom-ui-sm">
        <CombatFighterTile />
      </div>
      <CardContent
        className={cn(
          "combat-tile flex-1 flex flex-col gap-ui-xs ml-2.5",
          round ? "bg-card" : "bg-card/30"
        )}
      >
        <DottedTitle
          title="Fighter Attrition"
          textColor="text-foreground"
          className="m-[3px] mb-0"
        />

        <div className="relative h-full flex-1 min-h-0">
          <div className="absolute inset-0">
            <div className="absolute inset-0 bottom-0 z-10 dither-mask-sm dither-mask-invert text-card pointer-events-none" />
            <ScrollArea className="h-full z-0">
              {round && (
                <div className="flex flex-col gap-ui-xxs my-[3px] mb-10">
                  {(
                    [
                      [
                        "Successful Hits",
                        round.hits,
                        "Hits your committed fighters landed on the target",
                        (round.hits > 0 ? "terminal" : "warning") as StatTone,
                      ],
                      [
                        "Offensive Fighter Losses",
                        round.offensiveLosses,
                        "Your fighters lost while attacking (failed attack rolls)",
                        (round.offensiveLosses > 0 ? "destructive" : "accent-foreground") as StatTone,
                      ],
                      [
                        "Defensive Fighter Losses",
                        round.defensiveLosses,
                        "Your fighters destroyed by incoming enemy attacks",
                        (round.defensiveLosses > 0 ? "destructive" : "accent-foreground") as StatTone,
                      ],
                      [
                        "Total Fighter Losses",
                        totalFighterLosses,
                        "Combined offensive and defensive fighter losses this round",
                        (totalFighterLosses > 0 ? "destructive" : "accent-foreground") as StatTone,
                      ],
                      [
                        "Fighters Remaining",
                        round.fightersRemaining ?? "—",
                        "Your total fighters left after this round resolved",
                        (round.fightersRemaining && round.fightersRemaining <= 10
                          ? "warning"
                          : "white") as StatTone,
                      ],
                    ] as [string, string | number, string, StatTone][]
                  ).map(([label, value, help, tone], i) => (
                    <motion.div
                      key={label}
                      initial={{ opacity: 0, x: -16 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{
                        delay: i * 0.05,
                        type: "spring",
                        stiffness: 400,
                        damping: 30,
                      }}
                    >
                      <CombatStatTile
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

export const CombatRoundShieldResults = ({
  round,
}: {
  round: CombatPersonalRoundResult | null
}) => {
  const incomingPressure = (round?.defensiveLosses ?? 0) + (round?.shieldLoss ?? 0)
  const fleeOutcome =
    typeof round?.fleeSuccess === "boolean" ?
      round?.fleeSuccess ?
        "Success"
      : "Failed"
    : null

  return (
    <Card size="none" className="relative border-0 min-h-0 h-full flex flex-row bg-transparent">
      <div className="w-6 absolute right-0 z-20 inset-y-9 bottom-ui-sm">
        <CombatShieldTile />
      </div>
      <CardContent
        className={cn(
          "combat-tile flex-1 flex flex-col gap-ui-xs mr-2.5",
          round ? "bg-card" : "bg-card/30"
        )}
      >
        <DottedTitle title="Shield Pressure" textColor="text-foreground" className="m-[3px] mb-0" />
        <div className="relative h-full flex-1 min-h-0">
          <div className="absolute inset-0">
            <div className="absolute inset-0 bottom-0 z-10 dither-mask-sm dither-mask-invert text-card pointer-events-none" />
            <ScrollArea className="h-full z-0">
              {round && (
                <div className="flex flex-col gap-ui-xxs my-[3px] mb-10">
                  {(
                    [
                      [
                        "Incoming Pressure",
                        incomingPressure,
                        "Incoming damage pressure (defensive losses plus shield loss)",
                        (incomingPressure > 0 ? "destructive" : "accent-foreground") as StatTone,
                      ],
                      [
                        "Shield Loss",
                        round.shieldLoss,
                        "Shield points stripped this round by incoming pressure",
                        (round.shieldLoss > 0 ? "destructive" : "accent-foreground") as StatTone,
                      ],
                      [
                        "Shields Remaining",
                        round.shieldsRemaining ?? "—",
                        "Shield points left after this round resolved",
                        (round.shieldsRemaining && round.shieldsRemaining <= 10
                          ? "warning"
                          : "white") as StatTone,
                      ],
                      [
                        "Attack Target",
                        round.target ?? "None",
                        "Participant you targeted for attack this round",
                        "accent-foreground" as StatTone,
                      ],
                      ...(fleeOutcome
                        ? [
                            [
                              "Flee Attempt",
                              fleeOutcome,
                              "Whether your flee attempt succeeded this round",
                              (fleeOutcome === "Success" ? "terminal" : "warning") as StatTone,
                            ],
                          ]
                        : []),
                    ] as [string, string | number, string, StatTone][]
                  ).map(([label, value, help, tone], i) => (
                    <motion.div
                      key={label}
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{
                        delay: i * 0.05,
                        type: "spring",
                        stiffness: 400,
                        damping: 30,
                      }}
                    >
                      <CombatStatTile rtl label={label} value={value} help={help} tone={tone} />
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
