import { ChatPanel } from "@/components/ChatPanel"
import { useGameContext } from "@/hooks/useGameContext"
import { cn } from "@/utils/tailwind"

import { Divider } from "../primitives/Divider"
import { TextInputControl } from "../TextInputControl"
import { UserMicControl } from "../UserMicControl"

export const ConversationPanel = ({ className }: { className?: string }) => {
  const { sendUserTextInput } = useGameContext()
  return (
    <div className={cn("flex flex-col gap-2 h-full", className)}>
      <ChatPanel />
      <Divider className="bg-accent-background" />
      <div className="flex flex-row gap-2 items-center">
        <TextInputControl
          onSend={(text) => {
            sendUserTextInput?.(text)
          }}
        />
        <UserMicControl className="min-w-28" />
      </div>
    </div>
  )
}
