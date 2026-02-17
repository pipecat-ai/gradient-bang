import { ChatPanel } from "@/components/ChatPanel"
import { useGameContext } from "@/hooks/useGameContext"
import { cn } from "@/utils/tailwind"

import { Divider } from "../primitives/Divider"
import { TextInputControl } from "../TextInputControl"
import { UserMicControl } from "../UserMicControl"

export const ConversationPanel = ({ className }: { className?: string }) => {
  const { sendUserTextInput } = useGameContext()
  return (
    <div className={cn("flex flex-col gap-ui-xs h-full", className)}>
      <ChatPanel />
      <div className="flex flex-row gap-ui-xs items-center">
        <TextInputControl
          onSend={(text) => {
            sendUserTextInput?.(text)
          }}
        />
        <UserMicControl className="@2xl/main:min-w-30" />
      </div>
      <Divider variant="dashed" className="h-1.5 text-foreground/30 " />
    </div>
  )
}
