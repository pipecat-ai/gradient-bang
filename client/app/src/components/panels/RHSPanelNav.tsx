import * as React from "react"

import {
  ChatCircleTextIcon,
  CheckSquareOffsetIcon,
  PersonIcon,
  PlanetIcon,
  SwapIcon,
  UsersFourIcon,
} from "@phosphor-icons/react"

import { Button } from "@/components/primitives/Button"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { NewMessageFloater } from "../NewMessageFloater"

export const RHSPanelNavItem = ({
  children,
  active = false,
  label,
  onClick,
}: {
  children: React.ReactNode
  active: boolean
  label: string
  onClick: () => void
}) => {
  return (
    <Button
      variant="tab"
      size="tab"
      active={active}
      role="tab"
      aria-selected={active}
      aria-controls="#panel-container"
      aria-label={label}
      onClick={onClick}
      className="relative flex flex-col items-center justify-center gap-1 flex-1"
    >
      <span
        className={cn(
          "absolute inset-0 cross-lines-terminal-foreground/20 z-1 pointer-events-none animate-in zoom-in-0 duration-300 ease-in-out",
          active ? "block" : "hidden"
        )}
        aria-hidden="true"
      />
      {React.isValidElement(children) ?
        React.cloneElement(children, {
          weight: active ? "fill" : "regular",
        } as React.ComponentProps<React.ElementType>)
      : (children satisfies React.ReactNode)}
    </Button>
  )
}

export const RHSPanelNav = () => {
  const activePanel = useGameStore.use.activePanel?.()
  const setActivePanel = useGameStore.use.setActivePanel?.()

  const tabs = [
    { id: "sector", label: "Sector", icon: <PlanetIcon size={20} /> },
    { id: "player", label: "Player", icon: <PersonIcon size={20} /> },
    { id: "trade", label: "Trade", icon: <SwapIcon size={20} /> },
    { id: "tasks", label: "Tasks", icon: <CheckSquareOffsetIcon size={20} /> },
    { id: "corp", label: "Corp", icon: <UsersFourIcon size={20} /> },
    { id: "logs", label: "Waves", icon: <ChatCircleTextIcon size={20} /> },
  ]

  return (
    <div className="flex flex-col gap-1 items-center select-none relative flex-1 max-h-min border-l bg-background">
      <div className="relative flex flex-row gap-panel-gap w-full px-panel-gap">
        {tabs.map((tab) => (
          <RHSPanelNavItem
            key={tab.id}
            label={tab.label}
            active={activePanel === tab.id}
            onClick={() => {
              if (activePanel === tab.id) {
                setActivePanel(undefined)
                return
              }
              setActivePanel(tab.id as UIPanel)
            }}
          >
            {tab.icon}
            {tab.id === "logs" && <NewMessageFloater />}
            <span className="text-xxs truncate">{tab.label}</span>
          </RHSPanelNavItem>
        ))}
      </div>
    </div>
  )
}
