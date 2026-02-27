import type { Story } from "@ladle/react"
import { PipecatClientAudio } from "@pipecat-ai/client-react"

import { ConversationPanel } from "@/components/conversation/ConversationPanel"
import { ConversationProvider } from "@/components/conversation/ConversationProvider"

export const ConversationPanelStory: Story = () => (
  <div className="w-3xl h-96">
    <ConversationProvider>
      <ConversationPanel />
    </ConversationProvider>
    <PipecatClientAudio />
  </div>
)

ConversationPanelStory.meta = {
  useDevTools: true,
  enableMic: true,
  disableAudioOutput: false,
}
