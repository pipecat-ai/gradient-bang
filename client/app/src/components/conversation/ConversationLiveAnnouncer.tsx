import { useEffect, useEffectEvent, useId, useRef, useState } from "react"

import { useConversationStore } from "@/stores/conversation"

import type {
  BotOutputText,
  ConversationMessage,
  ConversationMessagePart,
} from "@/types/conversation"

interface ConversationLiveAnnouncerProps {
  assistantLabel?: string
  clientLabel?: string
}

interface AnnouncementState {
  key: number
  text: string
}

const ANNOUNCED_ROLES = new Set<ConversationMessage["role"]>(["assistant", "user"])

const isBotOutputText = (value: ConversationMessagePart["text"]): value is BotOutputText => {
  return (
    value !== null &&
    typeof value === "object" &&
    "spoken" in value &&
    "unspoken" in value &&
    typeof value.spoken === "string" &&
    typeof value.unspoken === "string"
  )
}

const getMessageTextContent = (message: ConversationMessage): string => {
  return message.parts
    .map((part) => {
      if (typeof part.text === "string") return part.text
      if (isBotOutputText(part.text)) {
        return part.text.spoken + part.text.unspoken
      }
      return ""
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

const buildAnnouncementText = (
  message: ConversationMessage,
  labels: Required<ConversationLiveAnnouncerProps>
): string | null => {
  if (!message.final || !ANNOUNCED_ROLES.has(message.role)) return null

  const content = getMessageTextContent(message)
  if (!content) return null

  const roleLabel = message.role === "assistant" ? labels.assistantLabel : labels.clientLabel
  return `${roleLabel}: ${content}`
}

const getAnnouncementMessageId = (message: ConversationMessage): string => {
  return `${message.role}:${message.createdAt}`
}

export const ConversationLiveAnnouncer = ({
  assistantLabel = "assistant",
  clientLabel = "user",
}: ConversationLiveAnnouncerProps) => {
  const callbackId = useId()
  const registerMessageCallback = useConversationStore((state) => state.registerMessageCallback)
  const unregisterMessageCallback = useConversationStore((state) => state.unregisterMessageCallback)

  const [announcement, setAnnouncement] = useState<AnnouncementState | null>(null)
  const announcedMessagesRef = useRef(new Map<string, string>())
  const announcementKeyRef = useRef(0)

  const announceMessage = useEffectEvent((message: ConversationMessage) => {
    const nextAnnouncement = buildAnnouncementText(message, {
      assistantLabel,
      clientLabel,
    })
    if (!nextAnnouncement) return

    const messageId = getAnnouncementMessageId(message)
    if (announcedMessagesRef.current.get(messageId) === nextAnnouncement) return

    announcedMessagesRef.current.set(messageId, nextAnnouncement)
    announcementKeyRef.current += 1
    setAnnouncement({
      key: announcementKeyRef.current,
      text: nextAnnouncement,
    })
  })

  useEffect(() => {
    registerMessageCallback(callbackId, announceMessage)

    return () => {
      unregisterMessageCallback(callbackId)
    }
  }, [callbackId, registerMessageCallback, unregisterMessageCallback])

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      aria-relevant="additions text"
      role="status"
      className="sr-only"
    >
      {announcement && <span key={announcement.key}>{announcement.text}</span>}
    </div>
  )
}
