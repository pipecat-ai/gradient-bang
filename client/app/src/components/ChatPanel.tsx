import { Fragment, useMemo } from "react"

import { button, useControls } from "leva"
import { faker } from "@faker-js/faker"
import { PlugsIcon } from "@phosphor-icons/react"

import { useChat } from "@/hooks/useChat"
import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import useGameStore from "@/stores/game"

import { Card, CardContent } from "./primitives/Card"
import { ScrollArea } from "./primitives/ScrollArea"

const ChatMessageRow = ({ message }: { message: ConversationMessage }) => {
  const timeString = useMemo(
    () =>
      new Date(message.createdAt).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    [message.createdAt]
  )
  return (
    <div className="flex flex-col gap-0 text-xxs">
      <div
        className={`${
          message.role === "assistant" ? "text-terminal"
          : message.role === "user" ? "text-fuel"
          : "text-warning"
        } font-extrabold text-xxs uppercase`}
      >
        <span className="opacity-50">[{timeString}]</span> {message.role}:
      </div>
      <div className="flex-1 normal-case tracking-normal conversation-message">
        {!message.parts?.length || message.parts.every((p) => !p.text) ?
          <span className="opacity-50 animate-pulse">...</span>
        : (message.parts ?? []).map((part, idx) => {
            const nextPart = message.parts?.[idx + 1] ?? null
            const isText = typeof part.text === "string"
            const nextIsText = nextPart && typeof nextPart.text === "string"
            return (
              <Fragment key={part.createdAt ?? idx}>
                {part.text}
                {isText && nextIsText ? " " : null}
              </Fragment>
            )
          })
        }
      </div>
    </div>
  )
}

export const ChatPanel = () => {
  const { isConnected } = usePipecatConnectionState()
  const { messages } = useChat({ textMode: "tts" })

  // #if DEV
  const addChatMessage = useGameStore.use.addChatMessage()

  useControls(
    "Chat",
    {
      ["Add Chat Message"]: button(() => {
        addChatMessage({
          role: "system",
          parts: [
            {
              text: faker.lorem.words({ min: 2, max: 25 }),
              final: true,
              createdAt: new Date().toISOString(),
            },
          ],
        })
      }),
    },
    { collapsed: true }
  )
  // #endif

  const clxConnected =
    "flex-1 h-full bg-card/60 border border-border dotted-mask-42 dotted-mask-black relative"
  const clxDisconnected = "flex-1 h-full opacity-40 stripe-frame-white/30 border border-border"

  const panelActive = isConnected || (messages?.length ?? 0) > 0

  return (
    <Card
      size="sm"
      variant={panelActive ? "default" : "stripes"}
      className={panelActive ? clxConnected : clxDisconnected}
    >
      {!panelActive && (
        <CardContent className="flex h-full items-center justify-center">
          <div className="text-center text-xs">
            <PlugsIcon weight="thin" size={72} className="animate-pulse" />
          </div>
        </CardContent>
      )}
      <div className="relative flex-1 mb-0">
        <CardContent className="absolute inset-0 min-h-0">
          <ScrollArea className="relative w-full h-full pointer-events-auto">
            <div className="flex flex-col gap-2">
              {messages?.toReversed().map((message) => (
                <ChatMessageRow key={message.createdAt} message={message} />
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </div>
    </Card>
  )
}
