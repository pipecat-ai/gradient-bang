import type { Story } from "@ladle/react"

import { Starfield as StarfieldComponent } from "@/components/Starfield"

export const StarfieldStory: Story = () => {
  return <StarfieldComponent />
}

StarfieldStory.meta = {
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
  useDevTools: true,
}
