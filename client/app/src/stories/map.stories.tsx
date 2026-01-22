import { useControls } from "leva"
import { Story } from "@ladle/react"

export const BigMapStory: Story = () => {

  useControls({
    center_sector: {
      value: 0,
      min: 0,
      max: 1000,
      step: 1,
    },
  })
  return <div>BigMapStory</div>
}

BigMapStory.meta = {
  enableMic: false,
  disableAudioOutput: true,
  useDevTools: true,
}