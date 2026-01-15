import type { Story } from "@ladle/react"

import { ChatPanel } from "@/components/ChatPanel"

export const ChatPanelStory: Story = () => (
  <div className="min-h-64">
    <ChatPanel />
  </div>
)

ChatPanelStory.meta = {}
