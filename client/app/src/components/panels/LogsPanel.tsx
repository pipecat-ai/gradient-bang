import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { CaretRightIcon } from "@phosphor-icons/react"

import { ToggleControl } from "@/components/primitives/ToggleControl"
import { ScrollNewItemsButton } from "@/components/ScrollNewItemsButton"
import { useAutoScroll } from "@/hooks/useAutoScroll"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { Button } from "../primitives/Button"
import { ButtonGroup } from "../primitives/ButtonGroup"
import { ScrollArea } from "../primitives/ScrollArea"
import { RHSPanelContent } from "./RHSPanelContainer"

const ACTIVITY_DURATION_MS = 5000

// Shared transition timing
const FADE_TRANSITION = {
  out: "duration-[1s] delay-[2s]",
  inSelf: "hover:duration-300 hover:delay-0 data-active:duration-300 data-active:delay-0",
  // Message targeting from parent
  messageBase:
    "[&_[data-slot=message]]:opacity-50 [&_[data-slot=message]]:transition-opacity [&_[data-slot=message]]:duration-[1s] [&_[data-slot=message]]:delay-[2s]",
  messageActive:
    "hover:[&_[data-slot=message]]:opacity-100 hover:[&_[data-slot=message]]:duration-300 hover:[&_[data-slot=message]]:delay-0 data-active:[&_[data-slot=message]]:opacity-100 data-active:[&_[data-slot=message]]:duration-300 data-active:[&_[data-slot=message]]:delay-0",
} as const

const MessageRow = ({ message, local = false }: { message: ChatMessage; local?: boolean }) => {
  return (
    <article
      aria-label={`Message from ${message.from_name}`}
      data-message_id={message.id}
      data-slot="message"
      className="text-xs flex flex-row gap-ui-sm"
    >
      <div className="flex-1">
        <span
          data-slot="message_from"
          className={cn(
            "flex flex-row items-center gap-1 font-semibold pb-0.5",
            local ? "text-fuel font-extrabold"
            : message.type === "direct" ? "text-terminal font-extrabold"
            : "text-foreground"
          )}
        >
          {message.type === "direct" && local && (
            <>
              <span className="font-semibold opacity-60 uppercase">you</span>
              <CaretRightIcon weight="fill" className="size-[10px] opacity-30" />
            </>
          )}
          {local ?
            message.type === "direct" ?
              message.to_name
            : "You"
          : message.from_name}
          {message.type === "direct" && !local && (
            <>
              <CaretRightIcon weight="fill" className="size-[10px] opacity-30" />
              <span className="font-semibold opacity-60 uppercase">you</span>
            </>
          )}
        </span>
        <p
          data-slot="message_content"
          className={cn(
            "text-xxs leading-relaxed",
            local ? "text-fuel-foreground font-semibold"
            : message.type === "direct" ? "text-terminal-foreground font-semibold"
            : "text-muted-foreground"
          )}
        >
          {message.content}
        </p>
      </div>
      <time
        dateTime={message.timestamp}
        className={cn("w-13 text-right font-bold text-foreground/30 text-xxs")}
      >
        [
        {new Date(message.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
        ]
      </time>
    </article>
  )
}

export const LogsPanel = () => {
  const messages = useGameStore.use.messages()
  const player = useGameStore.use.player()
  const prevMessagesLengthRef = useRef(messages?.length ?? 0)
  const {
    scrollRef,
    contentRef,
    resetAutoScroll,
    hasNewItems: hasNewMessages,
    dismissLock,
    trackItems,
  } = useAutoScroll()
  const messageFilters = useGameStore.use.messageFilters()
  const setMessageFilters = useGameStore.use.setMessageFilters()
  const [hasRecentActivity, setHasRecentActivity] = useState(false)
  const [muteBroadcastActivity, setMuteBroadcastActivity] = useState(false)
  const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevMessagesRef = useRef(messages)
  const setNotifications = useGameStore.use.setNotifications?.()
  const activePanel = useGameStore.use.activePanel?.()
  const prevActivePanelRef = useRef<string | undefined>(undefined)

  // Trigger activity state with auto-reset timeout
  const triggerActivity = useCallback(() => {
    if (activityTimeoutRef.current) {
      clearTimeout(activityTimeoutRef.current)
    }
    // Use microtask to satisfy linter (avoid sync setState in effect)
    queueMicrotask(() => setHasRecentActivity(true))
    activityTimeoutRef.current = setTimeout(() => {
      setHasRecentActivity(false)
    }, ACTIVITY_DURATION_MS)
  }, [])

  useEffect(() => {
    if (activePanel === "logs") {
      setNotifications({ newChatMessage: false })
    }
  }, [activePanel, setNotifications, messages])

  // Trigger activity state when panel becomes active
  useEffect(() => {
    const wasLogs = prevActivePanelRef.current === "logs"
    const isLogs = activePanel === "logs"
    prevActivePanelRef.current = activePanel

    if (!wasLogs && isLogs) {
      triggerActivity()
    }
  }, [activePanel, triggerActivity])

  const filteredMessages = useMemo(() => {
    return messages?.filter((message) => {
      if (messageFilters === "all") return true
      if (messageFilters === "direct" && message.type === "direct") return true
      if (messageFilters === "broadcast" && message.type === "broadcast") return true
      return false
    })
  }, [messages, messageFilters])

  // Scroll to bottom when filter changes
  useEffect(() => {
    resetAutoScroll()
  }, [messageFilters, resetAutoScroll])

  // Track items for the new-messages badge and detect activity
  useEffect(() => {
    if (!filteredMessages?.length) return

    trackItems(filteredMessages.length)

    if (filteredMessages.length !== prevMessagesLengthRef.current) {
      const isNewMessage = filteredMessages.length > prevMessagesLengthRef.current
      prevMessagesLengthRef.current = filteredMessages.length

      if (isNewMessage) {
        // Find new messages by comparing with previous
        const prevIds = new Set(prevMessagesRef.current?.map((m) => m.id) ?? [])
        const newMessages = messages?.filter((m) => !prevIds.has(m.id)) ?? []

        // Check if any new message should trigger activity
        const shouldTriggerActivity = newMessages.some(
          (m) => !(muteBroadcastActivity && m.type === "broadcast")
        )

        if (shouldTriggerActivity) {
          triggerActivity()
        }
      }
    }
    prevMessagesRef.current = messages
  }, [filteredMessages?.length, trackItems, messages, muteBroadcastActivity, triggerActivity])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (activityTimeoutRef.current) {
        clearTimeout(activityTimeoutRef.current)
      }
    }
  }, [])

  return (
    <RHSPanelContent noScroll className="bg-red-500">
      <div
        data-active={hasRecentActivity || undefined}
        className={cn(
          "group absolute inset-0 flex flex-col transition-colors hover:bg-background/60 data-active:bg-background/60",
          FADE_TRANSITION.out,
          FADE_TRANSITION.inSelf,
          FADE_TRANSITION.messageBase,
          FADE_TRANSITION.messageActive
        )}
      >
        <div className="shrink-0 p-ui-xs border-b flex flex-row justify-between items-center">
          <ButtonGroup className="bg-background/60">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMessageFilters("all")}
              className={messageFilters === "all" ? "bg-background text-accent-foreground" : ""}
            >
              All
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMessageFilters("direct")}
              className={messageFilters === "direct" ? "bg-background text-accent-foreground" : ""}
            >
              Direct
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMessageFilters("broadcast")}
              className={
                messageFilters === "broadcast" ? "bg-background text-accent-foreground" : ""
              }
            >
              Broadcast
            </Button>
          </ButtonGroup>

          <div className="flex flex-row items-center gap-2">
            <span className="text-xs text-muted-foreground">Mute broadcast</span>
            <ToggleControl
              id="mute-broadcast"
              size="sm"
              checked={muteBroadcastActivity}
              onCheckedChange={setMuteBroadcastActivity}
              className="bg-background/60"
            />
          </div>
        </div>
        <div className="relative flex-1 flex flex-col overflow-hidden min-h-0">
          <ScrollArea className="relative w-full flex-1 min-h-0" viewportRef={scrollRef}>
            <div className="flex flex-col min-h-full">
              <div className="flex-1" aria-hidden="true" />
              <div ref={contentRef} className="flex flex-col gap-ui-md p-ui-sm pb-10">
                {filteredMessages && player.name ?
                  filteredMessages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      local={player.name === message.from_name}
                    />
                  ))
                : <div className="w-full h-full flex items-center justify-center">
                    <span className="text-xs text-muted-foreground animate-pulse uppercase">
                      Awaiting wave history
                    </span>
                  </div>
                }
              </div>
            </div>
          </ScrollArea>
          {hasNewMessages && <ScrollNewItemsButton onClick={dismissLock} />}
        </div>
      </div>
    </RHSPanelContent>
  )
}
