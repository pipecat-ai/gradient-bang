import { memo, useEffect, useMemo, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { PlugsIcon } from "@phosphor-icons/react/dist/icons/Plugs"

import { Card, CardContent } from "@/components/primitives/Card"
import { ScrollArea } from "@/components/primitives/ScrollArea"
import { ToggleControl } from "@/components/primitives/ToggleControl"
import { ShipOSDVisualizer } from "@/components/ShipOSDVisualizer"
import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import { usePipecatConversation } from "@/hooks/usePipecatConversation"
import useAudioStore from "@/stores/audio"
import { useConversationStore } from "@/stores/conversation"

import { CopyContextButton } from "./CopyContextButton"
import { MessageContainer } from "./MessageContainer"

/**
 * Props for the Conversation component
 */
export interface ConversationProps {
  /**
   * Custom CSS classes for different parts of the component
   */
  classNames?: {
    /** CSS classes for the main container */
    container?: string
    /** CSS classes for individual message containers */
    message?: string
    /** CSS classes for message content area */
    messageContent?: string
    /** CSS classes for role labels */
    role?: string
    /** CSS classes for timestamp elements */
    time?: string
    /** CSS classes for thinking indicator */
    thinking?: string
  }
  /**
   * Disable automatic scrolling when new messages arrive
   * @default false
   */
  noAutoscroll?: boolean
  /**
   * Custom label for assistant messages
   * @default "assistant"
   */
  assistantLabel?: string
  /**
   * Custom label for user/client messages
   * @default "user"
   */
  clientLabel?: string
  /**
   * Custom label for system messages
   * @default "system"
   */
  systemLabel?: string
  /**
   * Custom label for function call entries
   * @default "function call"
   */
  functionCallLabel?: string
  /**
   * Custom renderer for function call messages.
   * When provided, replaces the default function call rendering.
   * Receives the full FunctionCallData so developers can render
   * differently based on function name, status, args, and result.
   *
   * @example
   * ```tsx
   * <Conversation
   *   functionCallRenderer={(fc) => {
   *     switch (fc.function_name) {
   *       case "get_weather":
   *         return <WeatherCard functionCall={fc} />;
   *       default:
   *         return <FunctionCallContent functionCall={fc} />;
   *     }
   *   }}
   * />
   * ```
   */
  functionCallRenderer?: React.ComponentProps<typeof MessageContainer>["functionCallRenderer"]
  /**
   * Disable the text input field at the bottom of the conversation
   * @default false
   */
  noTextInput?: boolean
  /**
   * Disable rendering of function call messages in the conversation.
   * Function call data is still captured in the store.
   * @default false
   */
  noFunctionCalls?: boolean
  /**
   * Custom renderers for BotOutput content based on aggregation type
   * Key is the aggregation type (e.g., "code", "link"), value is a renderer function
   */
  botOutputRenderers?: React.ComponentProps<typeof MessageContainer>["botOutputRenderers"]
  /**
   * Metadata for aggregation types to control rendering and speech progress behavior
   * Key is the aggregation type (e.g., "code", "link"), value is metadata configuration
   */
  aggregationMetadata?: React.ComponentProps<typeof MessageContainer>["aggregationMetadata"]
}

/**
 * Conversation component that displays real-time conversation history between users and AI assistants.
 *
 * This component automatically integrates with the Pipecat Client SDK to show messages,
 * connection states, and provides smooth scrolling behavior. It must be used within
 * a PipecatClientProvider and ConversationProvider context.
 *
 * @example
 * ```tsx
 * import { Conversation } from "@pipecat-ai/voice-ui-kit";
 *
 * <div className="h-96 border rounded-lg">
 *   <Conversation
 *     assistantLabel="AI Assistant"
 *     clientLabel="You"
 *     noAutoscroll={false}
 *   />
 * </div>
 * ```
 *
 * @param props - The component props
 * @param props.classNames - Custom CSS classes for styling different parts
 * @param props.noAutoscroll - Whether to disable automatic scrolling
 * @param props.assistantLabel - Custom label for assistant messages
 * @param props.clientLabel - Custom label for user messages
 *
 * @returns A React component that renders the conversation interface
 */
export const Conversation: React.FC<ConversationProps> = memo(
  ({
    assistantLabel,
    clientLabel,
    noFunctionCalls = false,
    systemLabel,
    functionCallLabel,
    functionCallRenderer,
    botOutputRenderers,
    aggregationMetadata,
  }) => {
    const [showSystem, setShowSystem] = useState(false)
    const llmIsWorking = useConversationStore((state) => state.isThinking)
    const sayTextActive = useConversationStore((state) => state.sayTextActive)
    const thinkCount = useRef(0)

    const { isConnected } = usePipecatConnectionState()

    const { messages: allMessages } = usePipecatConversation({
      aggregationMetadata,
    })

    useEffect(() => {
      if (llmIsWorking) {
        if (thinkCount.current > 0) {
          useAudioStore.getState().playSound("chime7", { volume: 0.25 })
        }
        thinkCount.current++
      }
    }, [llmIsWorking])

    const messages = useMemo(
      () =>
        allMessages
          .filter((m) => {
            if (noFunctionCalls && m.role === "function_call") return false
            if (!showSystem && (m.role === "system" || m.role === "ui")) return false
            return true
          })
          .reverse(),
      [allMessages, noFunctionCalls, showSystem]
    )

    const messageCount = useMemo(() => allMessages.length, [allMessages])

    const panelActive = isConnected || messageCount > 0

    return (
      <Card
        size="xs"
        variant={panelActive ? "default" : "stripes"}
        className={
          panelActive ?
            "group flex-1 h-full bg-card/70 relative border-0 border-b border-b-foreground/30"
          : "group relative flex-1 h-full opacity-50 stripe-frame-white/30"
        }
      >
        {!panelActive ?
          <CardContent className="flex h-full items-center justify-center">
            <div className="text-center text-xs">
              <PlugsIcon weight="thin" size={72} className="animate-pulse" aria-hidden="true" />
              <span className="sr-only">Disconnected</span>
            </div>
          </CardContent>
        : <>
            <div className="absolute right-ui-sm bottom-ui-sm group-hover:bg-background/60 w-fit h-fit inline-flex items-center gap-ui-xs px-ui-xxs py-ui-xxs z-20 opacity-50 group-hover:opacity-100 transition-opacity">
              <CopyContextButton />
              <span className="text-xxs uppercase text-foreground px-ui-xxs opacity-0 group-hover:opacity-100 transition-opacity">
                Show system
              </span>
              <ToggleControl size="sm" checked={showSystem} onCheckedChange={setShowSystem} />
            </div>
            <div className="relative flex-1 mb-0 text-foreground">
              {!sayTextActive && (
                <div className="absolute bottom-0 inset-x-0 h-15 z-10 pointer-events-none pl-ui-xs">
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
                          role="status"
                          aria-live="polite"
                          aria-label="Assistant is thinking"
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
              )}
              <CardContent className="absolute inset-0 min-h-0  mask-[linear-gradient(to_bottom,black_60%,transparent_100%)]">
                <ScrollArea className="relative w-full h-full pointer-events-auto">
                  <div
                    role="log"
                    aria-live="polite"
                    aria-label="Conversation messages"
                    className="flex flex-col gap-2 pb-20"
                  >
                    {messages.map((message, index) => (
                      <MessageContainer
                        key={index}
                        message={message}
                        assistantLabel={assistantLabel}
                        clientLabel={clientLabel}
                        systemLabel={systemLabel}
                        functionCallLabel={functionCallLabel}
                        functionCallRenderer={functionCallRenderer}
                        botOutputRenderers={botOutputRenderers}
                        aggregationMetadata={aggregationMetadata}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </div>
          </>
        }
      </Card>
    )
  }
)

/**
 * Default export of the Conversation component
 */
export default Conversation
