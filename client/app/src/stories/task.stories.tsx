import type { Story } from "@ladle/react"

import { PlayerShipPanel } from "@/components/panels/PlayerShipPanel"
import { TaskEnginesPanel } from "@/components/panels/TaskEnginesPanel"

export const TaskEnginesStory: Story = () => {
  return (
    <>
      <TaskEnginesPanel />
      <PlayerShipPanel />
    </>
  )
}

TaskEnginesStory.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: false,
  useDevTools: true,
}
