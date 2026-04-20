import { FunctionCallContent } from "@/components/conversation/FunctionCallContent"
import { MessageContent } from "@/components/conversation/MessageContent"
import { UiContent } from "@/components/conversation/UiContent"
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
  if (message.role === "ui") {
    return (
      <div className={cn("flex flex-col gap-2")}>
        <UiContent message={message} />
      </div>
    )
  }

  if (message.role === "function_call" && message.functionCall) {
    return (
      <div className={cn("flex flex-col gap-2")}>
        <FunctionCallContent
          functionCall={message.functionCall}
          createdAt={message.createdAt}
          functionCallLabel={functionCallLabel}
          functionCallRenderer={functionCallRenderer}
        />
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-2")}>
      <MessageContent
        message={message}
        assistantLabel={assistantLabel}
        clientLabel={clientLabel}
        systemLabel={systemLabel}
        functionCallLabel={functionCallLabel}
        botOutputRenderers={botOutputRenderers}
        aggregationMetadata={aggregationMetadata}
      />
    </div>
  )
}
