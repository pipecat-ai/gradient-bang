import { useCallback, useMemo, useRef } from "react"

import { cva } from "class-variance-authority"
import { motion } from "motion/react"
import { CheckCircleIcon, LockSimpleIcon } from "@phosphor-icons/react"

import CharacterPortrait1 from "@/assets/images/characters/fed-cadet-1.png"
import CharacterPortrait2 from "@/assets/images/characters/fed-cadet-2.png"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { Badge } from "../primitives/Badge"
import { Card, CardContent } from "../primitives/Card"
import { BaseDialog } from "./BaseDialog"

const QUEST_GIVERS = [
  {
    id: "cadet-amy",
    name: "Cadet Amy",
    description: "Federation Intake",
    questCode: "tutorial",
    locked: false,
    portrait: CharacterPortrait1,
  },
  {
    id: "commander-voss",
    name: "Commander Voss",
    description: "Federation Military",
    questCode: "tutorial_corporations",
    locked: false,
    portrait: CharacterPortrait2,
  },
  {
    id: "dr-nexus",
    name: "Dr. Nexus",
    description: "Research Division",
    questCode: null,
    locked: true,
    portrait: null,
  },
]

type QuestStatus = "active" | "completed" | "available" | "locked"

const questCardVariants = cva(
  "interactive-card group focus-outline focus-hover relative py-0 border h-96 w-56 elbow select-none elbow-offset-1 hover:scale-105 focus-visible:scale-105 transition-transform duration-300 ease-in-out cursor-pointer",
  {
    variants: {
      status: {
        active:
          "bg-fuel-background border-fuel/50 elbow-fuel hover:border-fuel focus-visible:elbow-fuel hover:-elbow-offset-3 focus-visible:-elbow-offset-3",
        completed:
          "opacity-50 bg-transparent cross-lines-terminal-foreground cross-lines-offset-8 pointer-events-none",
        available:
          "bg-card elbow-subtle-foreground hover:elbow-foreground focus-visible:elbow-foreground hover:-elbow-offset-3 focus-visible:-elbow-offset-3",
        locked:
          "bg-card/30 elbow-subtle-foreground hover:elbow-foreground focus-visible:elbow-foreground hover:-elbow-offset-3 focus-visible:-elbow-offset-3",
      },
    },
    defaultVariants: {
      status: "available",
    },
  }
)

const questCardInnerVariants = cva(
  "h-full text-accent-background border-0 group-hover:text-accent group-focus-visible:text-accent overflow-hidden",
  {
    variants: {
      status: {
        active: "bg-terminal/20!",
        completed: "bg-black!",
        available: "bg-black!",
        locked: "bg-black!",
      },
    },
    defaultVariants: {
      status: "available",
    },
  }
)

const STATUS_CONFIG: Record<
  QuestStatus,
  { label: string; variant: "highlight" | "success" | "default"; icon?: typeof CheckCircleIcon }
> = {
  active: { label: "In Progress", variant: "highlight" },
  completed: { label: "Complete", variant: "success", icon: CheckCircleIcon },
  available: { label: "Accept contract", variant: "success" },
  locked: { label: "Locked", variant: "default", icon: LockSimpleIcon },
}

const QuestGiverCard = ({
  questGiver,
  index,
  status,
  onSelect,
}: {
  questGiver: (typeof QUEST_GIVERS)[number]
  index: number
  status: QuestStatus
  onSelect: (questGiver: (typeof QUEST_GIVERS)[number]) => void
}) => {
  const config = STATUS_CONFIG[status]
  const Icon = config.icon

  return (
    <motion.div
      className="flex flex-col items-center gap-3"
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, delay: 0.15 + index * 0.1, ease: "easeOut" }}
    >
      <div
        tabIndex={0}
        role="button"
        className={cn(questCardVariants({ status }))}
        onClick={() => onSelect(questGiver)}
      >
        <Card className={cn(questCardInnerVariants({ status }))} size="none">
          <CardContent className="relative h-full">
            {questGiver.locked ?
              <div className="w-full h-full flex items-center justify-center bg-background/50 cross-lines-accent-background cross-lines-offset-8">
                <LockSimpleIcon
                  weight="bold"
                  size={32}
                  className="relative z-10 text-accent-foreground"
                />
              </div>
            : <img
                src={questGiver.portrait!}
                alt={questGiver.name}
                className="h-full w-auto object-cover"
              />
            }
            <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/90 via-black/50 to-transparent px-ui-sm pb-ui-md pt-8">
              <span className="group-hover:text-terminal group-focus-visible:text-terminal text-center block text-white uppercase font-medium truncate leading-none">
                {questGiver.locked ? "???" : questGiver.name}
              </span>
              <span className="text-center uppercase block text-xxs text-subtle-foreground truncate mt-2">
                {questGiver.locked ? "Locked" : questGiver.description}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
      <Badge variant={config.variant} size="sm">
        {Icon && <Icon weight="fill" size={10} />}
        {config.label}
      </Badge>
    </motion.div>
  )
}

export const QuestList = () => {
  const quests = useGameStore.use.quests()
  const dispatchAction = useGameStore.use.dispatchAction()
  const setActiveModal = useGameStore.use.setActiveModal()
  const setNotifications = useGameStore.use.setNotifications()
  const diamondRef = useRef<HTMLDivElement>(null)

  const questStatusMap = useMemo(() => {
    const map = new Map<string, QuestStatus>()
    for (const quest of quests) {
      map.set(quest.code, quest.status === "completed" ? "completed" : "active")
    }
    return map
  }, [quests])

  const getStatus = useCallback(
    (questGiver: (typeof QUEST_GIVERS)[number]): QuestStatus => {
      if (questGiver.locked) return "locked"
      if (!questGiver.questCode) return "available"
      return questStatusMap.get(questGiver.questCode) ?? "available"
    },
    [questStatusMap]
  )

  const handleSelect = useCallback(
    (questGiver: (typeof QUEST_GIVERS)[number]) => {
      if (questGiver.locked || !questGiver.questCode) return
      if (getStatus(questGiver) !== "available") return

      console.log(`[GAME] Accepting quest from ${questGiver.name}`)
      dispatchAction({ type: "assign-quest", payload: { quest_code: questGiver.questCode } })
      setActiveModal(undefined)
      setNotifications({ questAccepted: true })
    },
    [dispatchAction, setActiveModal, setNotifications, getStatus]
  )

  return (
    <BaseDialog modalName="quest_list" title="Quests" size="lg" useDiamondFX diamondRef={diamondRef}>
      <div ref={diamondRef} className="flex flex-row gap-6 justify-center">
        {QUEST_GIVERS.map((questGiver, index) => (
          <QuestGiverCard
            key={questGiver.id}
            questGiver={questGiver}
            index={index}
            status={getStatus(questGiver)}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </BaseDialog>
  )
}
