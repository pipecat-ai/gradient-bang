import { FunctionCallContent } from "@/components/conversation/FunctionCallContent"
import { MessageContent } from "@/components/conversation/MessageContent"
import { MessageRole } from "@/components/conversation/MessageRole"
import { cn } from "@/utils/tailwind"

import type {
  AggregationMetadata,
  ConversationMessage,
  FunctionCallRenderer,
} from "@/types/conversation"

interface Props {
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
   */
  functionCallRenderer?: FunctionCallRenderer
  /**
   * The message to display
   */
  message: ConversationMessage
  /**
   * Custom renderers for BotOutput content based on aggregation type
   */
  botOutputRenderers?: React.ComponentProps<typeof MessageContent>["botOutputRenderers"]
  /**
   * Metadata for aggregation types to control rendering and speech progress behavior
   */
  aggregationMetadata?: Record<string, AggregationMetadata>
}

export const MessageContainer = ({
  assistantLabel,
  clientLabel,
  systemLabel,
  functionCallLabel,
  functionCallRenderer,
  message,
  botOutputRenderers,
  aggregationMetadata,
}: Props) => {
  if (message.role === "function_call" && message.functionCall) {
    return (
      <div className={cn("flex flex-col gap-2")}>
        <FunctionCallContent
          functionCall={message.functionCall}
          functionCallLabel={functionCallLabel}
          functionCallRenderer={functionCallRenderer}
        />
        <div className={cn("self-end text-xs text-gray-500 mb-1")}>
          {new Date(message.createdAt).toLocaleTimeString()}
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-2")}>
      <MessageRole
        assistantLabel={assistantLabel}
        clientLabel={clientLabel}
        systemLabel={systemLabel}
        functionCallLabel={functionCallLabel}
        role={message.role}
      />
      <MessageContent
        message={message}
        botOutputRenderers={botOutputRenderers}
        aggregationMetadata={aggregationMetadata}
      />
    </div>
  )
}
