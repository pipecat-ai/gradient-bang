import { useEffect, useMemo, useRef, useState } from "react"

import { CaretRightIcon } from "@phosphor-icons/react"

import { ToggleControl } from "@/components/primitives/ToggleControl"
import { useAutoScroll } from "@/hooks/useAutoScroll"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { Button } from "../primitives/Button"
import { ButtonGroup } from "../primitives/ButtonGroup"
import { Field, FieldLabel } from "../primitives/Field"
import { ScrollArea } from "../primitives/ScrollArea"

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

const MessageRow = ({ message }: { message: ChatMessage }) => {
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
            "flex flex-row items-center gap-1 font-semibold  pb-0.5",
            message.type === "direct" ? "text-fuel font-extrabold" : "text-foreground"
          )}
        >
          {message.from_name}
          {message.type === "direct" && (
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
            message.type === "direct" ?
              "text-fuel-foreground font-semibold"
            : "text-muted-foreground"
          )}
        >
          {message.content}
        </p>
      </div>
      <time dateTime={message.timestamp} className="w-13 text-right text-accent font-bold">
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
  const prevMessagesLengthRef = useRef(messages.length)
  const { AutoScrollAnchor, handleScroll, scrollToBottom } = useAutoScroll()
  const messageFilters = useGameStore.use.messageFilters()
  const setMessageFilters = useGameStore.use.setMessageFilters()
  const [hasRecentActivity, setHasRecentActivity] = useState(false)
  const [muteBroadcastActivity, setMuteBroadcastActivity] = useState(false)
  const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevMessagesRef = useRef(messages)

  const filteredMessages = useMemo(() => {
    return messages.filter((message) => {
      if (messageFilters === "all") return true
      if (messageFilters === "direct" && message.type === "direct") return true
      if (messageFilters === "broadcast" && message.type === "broadcast") return true
      return false
    })
  }, [messages, messageFilters])

  // Scroll and track activity when messages change
  useEffect(() => {
    if (filteredMessages.length !== prevMessagesLengthRef.current) {
      const isNewMessage = filteredMessages.length > prevMessagesLengthRef.current
      prevMessagesLengthRef.current = filteredMessages.length
      scrollToBottom()

      if (isNewMessage) {
        // Find new messages by comparing with previous
        const prevIds = new Set(prevMessagesRef.current.map((m) => m.id))
        const newMessages = messages.filter((m) => !prevIds.has(m.id))

        // Check if any new message should trigger activity
        const shouldTriggerActivity = newMessages.some(
          (m) => !(muteBroadcastActivity && m.type === "broadcast")
        )

        if (shouldTriggerActivity) {
          // Clear existing timeout
          if (activityTimeoutRef.current) {
            clearTimeout(activityTimeoutRef.current)
          }
          // Activate immediately (via microtask to satisfy linter), deactivate after duration
          queueMicrotask(() => setHasRecentActivity(true))
          activityTimeoutRef.current = setTimeout(() => {
            setHasRecentActivity(false)
          }, ACTIVITY_DURATION_MS)
        }
      }
    }
    prevMessagesRef.current = messages
  }, [filteredMessages.length, scrollToBottom, messages, muteBroadcastActivity])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (activityTimeoutRef.current) {
        clearTimeout(activityTimeoutRef.current)
      }
    }
  }, [])

  return (
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
        <ButtonGroup>
          <Button variant="outline" size="sm" onClick={() => setMessageFilters("all")}>
            All
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMessageFilters("direct")}>
            Direct
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMessageFilters("broadcast")}>
            Broadcast
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMessageFilters("broadcast")}>
            Corp
          </Button>
        </ButtonGroup>

        <div className="flex flex-row items-center gap-2">
          <span className="text-xs text-muted-foreground">Mute broadcast</span>
          <ToggleControl
            id="mute-broadcast"
            checked={muteBroadcastActivity}
            onCheckedChange={setMuteBroadcastActivity}
          />
        </div>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <ScrollArea
          className="relative w-full flex-1 overflow-hidden"
          fullHeight
          onScroll={handleScroll}
        >
          <div className="table-cell align-bottom h-full p-ui-sm">
            <div className="flex flex-col gap-ui-md pb-10">
              {filteredMessages.map((message) => (
                <MessageRow key={message.id} message={message} />
              ))}
              <AutoScrollAnchor />
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
