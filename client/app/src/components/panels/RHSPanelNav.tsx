import * as React from "react"

import {
  ChatCircleTextIcon,
  CheckSquareOffsetIcon,
  CrosshairIcon,
  PersonIcon,
  PlanetIcon,
  SwapIcon,
  UsersFourIcon,
} from "@phosphor-icons/react"

import { Button } from "@/components/primitives/Button"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { NewMessageFloater } from "../NewMessageFloater"

const HighlightHotkey = ({ label, hotkey }: { label: string; hotkey?: string }) => {
  if (!hotkey) return <>{label}</>
  const idx = label.toLowerCase().indexOf(hotkey.toLowerCase())
  if (idx === -1) return <>{label}</>
  return (
    <>
      {label.slice(0, idx)}
      <span className="underline underline-offset-2 decoration-current/60">{label[idx]}</span>
      {label.slice(idx + 1)}
    </>
  )
}

export const RHSPanelNavItem = ({
  id,
  children,
  active = false,
  label,
  onClick,
  disabled = false,
}: {
  id: string
  children: React.ReactNode
  active: boolean
  label: string
  onClick: () => void
  disabled?: boolean
}) => {
  return (
    <Button
      id={id}
      variant="tab"
      size="tab"
      active={active}
      role="tab"
      aria-selected={active}
      aria-controls="#panel-container"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
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
  const uiState = useGameStore.use.uiState?.()

  const hotkeyMap = React.useMemo(
    () =>
      new Map([
        ["s", "sector"],
        ["p", "player"],
        ["t", "trade"],
        ["h", "task_history"],
        ["c", "corp"],
        ["w", "logs"],
      ]),
    []
  )

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const tabId = hotkeyMap.get(e.key.toLowerCase())
      if (!tabId) return

      if (uiState === "combat" && tabId !== "logs" && tabId !== "sector") return

      e.preventDefault()
      setActivePanel(activePanel === tabId ? undefined : (tabId as UIPanel))
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [activePanel, setActivePanel, uiState, hotkeyMap])

  const tabs = [
    {
      id: "sector",
      label: "Sector",
      disabledLabel: "Combat",
      icon: <PlanetIcon size={20} />,
      disabledIcon: <CrosshairIcon size={20} />,
      hotkey: "s",
    },
    { id: "player", label: "Player", icon: <PersonIcon size={20} />, hotkey: "p" },
    { id: "trade", label: "Trade", icon: <SwapIcon size={20} />, hotkey: "t" },
    {
      id: "task_history",
      label: "History",
      icon: <CheckSquareOffsetIcon size={20} />,
      hotkey: "h",
    },
    { id: "rank", label: "Rank", icon: <UsersFourIcon size={20} />, hotkey: "r" },
    { id: "logs", label: "Waves", icon: <ChatCircleTextIcon size={20} />, hotkey: "w" },
  ]

  return (
    <div className="flex flex-col gap-1 items-center select-none relative flex-1 max-h-min border-l bg-background">
      <div className="relative flex flex-row gap-panel-gap w-full px-panel-gap">
        {tabs.map((tab) => (
          <RHSPanelNavItem
            id={tab.id}
            key={tab.id}
            label={tab.label}
            active={activePanel === tab.id}
            disabled={uiState === "combat" && tab.id !== "logs" && tab.id !== "sector"}
            onClick={() => {
              if (activePanel === tab.id) {
                setActivePanel(undefined)
                return
              }
              setActivePanel(tab.id as UIPanel)
            }}
          >
            {uiState === "combat" ? (tab.disabledIcon ?? tab.icon) : tab.icon}
            {tab.id === "logs" && <NewMessageFloater />}
            <span className="text-xxs truncate">
              {uiState === "combat" ?
                <HighlightHotkey label={tab.disabledLabel ?? tab.label} hotkey={tab.hotkey} />
              : <HighlightHotkey label={tab.label} hotkey={tab.hotkey} />}
            </span>
          </RHSPanelNavItem>
        ))}
      </div>
    </div>
  )
}
