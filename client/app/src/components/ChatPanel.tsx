import { Fragment, useEffect, useMemo } from "react"

import { AnimatePresence, motion } from "motion/react"
import { PlugsIcon, WrenchIcon } from "@phosphor-icons/react"

import { useChat } from "@/hooks/useChat"
import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

import { Card, CardContent } from "./primitives/Card"
import { ScrollArea } from "./primitives/ScrollArea"
import { ShipOSDVisualizer } from "./ShipOSDVisualizer"

const ChatMessageToolCallRow = ({ message }: { message: ConversationMessage }) => {
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
    <div className="text-subtle-foreground font-extrabold text-xxs uppercase inline-flex gap-1 items-center">
      <span className="text-accent-foreground">[{timeString}]</span>
      <WrenchIcon weight="fill" size={11} className="size-[11px]" />
      <span>Tool call </span>
      <span className="font-bold text-medium">({message.parts?.[0]?.text})</span>
    </div>
  )
}
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
    <div className="flex flex-col gap-0 text-xxs text-foreground">
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
  const playSound = useAudioStore.use.playSound()
  const { messages } = useChat({ textMode: "llm" })
  const llmIsWorking = useGameStore.use.llmIsWorking()

  useEffect(() => {
    if (llmIsWorking) {
      playSound("chime7", { volume: 0.25 })
    }
  }, [llmIsWorking, playSound])

  const clxConnected = "flex-1 h-full bg-card/60 relative border-0 border-b border-b-foreground/30"
  const clxDisconnected = "flex-1 h-full opacity-50 stripe-frame-white/30"

  const panelActive = isConnected || (messages?.length ?? 0) > 0

  return (
    <Card
      size="xs"
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
      <div className="relative flex-1 mb-0 text-foreground">
        <div className="absolute bottom-0 inset-x-0 h-[60px] z-10 pointer-events-none pl-ui-xs">
          <div className="relative inline-block">
            <ShipOSDVisualizer
              barLineCap="square"
              participantType="bot"
              barColor="white"
              peakLineColor="--color-terminal"
              peakLineThickness={2}
              peakOffset={6}
              barMaxHeight={60}
              barCount={12}
              barWidth={4}
              barGap={8}
              barOrigin="bottom"
              isThinking={llmIsWorking}
              thinkingSpeed={4}
              thinkingMaxHeight={15}
              className={llmIsWorking ? "opacity-40" : "opacity-100"}
            />
            <AnimatePresence>
              {llmIsWorking && (
                <motion.div
                  key="thinking-badge"
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 20, opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="absolute bottom-ui-xs inset-x-0 flex flex-col items-center justify-center"
                >
                  <div className="px-2 py-1 bg-terminal-background/80 elbow elbow-1 elbow-offset-0 elbow-size-6 elbow-terminal text-terminal-foreground text-xs uppercase animate-pulse">
                    Thinking
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <CardContent className="absolute inset-0 min-h-0  mask-[linear-gradient(to_bottom,black_60%,transparent_100%)]">
          <ScrollArea className="relative w-full h-full pointer-events-auto">
            <div className="flex flex-col gap-2">
              {messages
                ?.toReversed()
                .map((message) =>
                  message.role === "tool" ?
                    <ChatMessageToolCallRow key={message.createdAt} message={message} />
                  : <ChatMessageRow key={message.createdAt} message={message} />
                )}
            </div>
          </ScrollArea>
        </CardContent>
      </div>
    </Card>
  )
}
