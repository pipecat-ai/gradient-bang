import { Story } from "@ladle/react"

import { MiniMapPanel } from "@/components/panels/MiniMapPanel"

export const MiniMapStory: Story = () => {
  return (
    <div className="flex flex-col items-center justify-center w-screen h-screen bg-white">
      <div className="w-[330px] h-[330px] max-h-[330px]  overflow-hidden">
        <MiniMapPanel />
      </div>
    </div>
  )
}
MiniMapStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}
