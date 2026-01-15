import { button, useControls } from "leva"
import type { Story } from "@ladle/react"

import { Starfield } from "@/hud/StarField"
import useGameStore from "@/stores/game"

export const Default: Story = () => {
  useControls(
    {
      ["Toggle Render Setting"]: button(() => {
        const { settings, setSettings } = useGameStore.getState()
        setSettings({ ...settings, renderStarfield: !settings.renderStarfield })
      }),
    },
    { collapsed: true }
  )

  return (
    <div className="relative w-full h-screen bg-black">
      <Starfield debug={false} />
    </div>
  )
}

Default.meta = {
  disconnectedStory: true,
}

export const HighPerformance: Story = () => {
  return (
    <div className="relative w-full h-screen bg-black">
      <Starfield debug={true} profile="high" />
    </div>
  )
}

HighPerformance.meta = {
  disconnectedStory: true,
}

export const LowPerformance: Story = () => {
  return (
    <div className="relative w-full h-screen bg-black">
      <Starfield debug={true} profile="low" />
    </div>
  )
}

LowPerformance.meta = {
  disconnectedStory: true,
}

export const NoDebug: Story = () => {
  return (
    <div className="relative w-full h-screen bg-black">
      <Starfield debug={false} profile="mid" />
    </div>
  )
}

NoDebug.meta = {
  disconnectedStory: true,
}
