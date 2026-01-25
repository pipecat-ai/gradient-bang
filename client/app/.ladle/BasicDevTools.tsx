import { ChatPanel } from "@/components/ChatPanel"
import { Divider } from "@/components/primitives/Divider"
import { TextInputControl } from "@/components/TextInputControl"
import { useGameContext } from "@/hooks/useGameContext"

export const BasicDevTools = () => {
  const { sendUserTextInput } = useGameContext()
  return (
    <div className="story-card">
      <div className="flex flex-col gap-3">
        <TextInputControl
          onSend={(text) => {
            sendUserTextInput?.(text)
          }}
        />
        <Divider />
      </div>

      <div className="shrink-0 relative h-[350px]">
        <ChatPanel />
      </div>
    </div>
  )
}
