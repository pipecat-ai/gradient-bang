import type { Story } from "@ladle/react"

import { sounds } from "@/assets"
import { Settings } from "@/components/dialogs/Settings"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

const soundNames = Object.keys(sounds) as (keyof typeof sounds)[]

const SoundButton = ({ name }: { name: keyof typeof sounds }) => {
  const playSound = useAudioStore.use.playSound()

  return (
    <button
      onClick={() => playSound(name)}
      className="px-4 py-2 bg-card hover:bg-accent text-foreground text-sm font-medium border border-border hover:border-accent-foreground transition-colors uppercase tracking-wide"
    >
      {name}
    </button>
  )
}

const LoopingSoundButton = ({ name }: { name: keyof typeof sounds }) => {
  const playSound = useAudioStore.use.playSound()
  const stopSound = useAudioStore.use.stopSound()

  return (
    <div className="flex gap-2">
      <button
        onClick={() => playSound(name, { once: true })}
        className="px-4 py-2 bg-terminal/20 hover:bg-terminal/40 text-terminal text-sm font-medium border border-terminal/50 hover:border-terminal transition-colors uppercase tracking-wide"
      >
        Loop {name}
      </button>
      <button
        onClick={() => stopSound(name)}
        className="px-4 py-2 bg-destructive/20 hover:bg-destructive/40 text-destructive text-sm font-medium border border-destructive/50 hover:border-destructive transition-colors uppercase tracking-wide"
      >
        Stop
      </button>
    </div>
  )
}

export const AudioTestStory: Story = () => {
  const setActiveModal = useGameStore.use.setActiveModal()

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground uppercase tracking-wider">
            Audio Test
          </h1>
          <p className="text-sm text-muted-foreground">Test sound playback and volume controls</p>
        </div>

        {/* Settings Button */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-accent-foreground uppercase tracking-wide">
            Settings
          </h2>
          <button
            onClick={() => setActiveModal("settings")}
            className="px-6 py-3 bg-accent hover:bg-accent/80 text-accent-foreground text-sm font-bold border-2 border-accent-foreground/30 hover:border-accent-foreground transition-colors uppercase tracking-wider"
          >
            Open Settings Modal
          </button>
        </div>

        {/* One-shot Sounds */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-accent-foreground uppercase tracking-wide">
            One-shot Sounds (FX)
          </h2>
          <div className="flex flex-wrap gap-2">
            {soundNames
              .filter((name) => name !== "ambience")
              .map((name) => (
                <SoundButton key={name} name={name} />
              ))}
          </div>
        </div>

        {/* Looping Sounds */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-accent-foreground uppercase tracking-wide">
            Looping Sounds (Ambience)
          </h2>
          <LoopingSoundButton name="ambience" />
        </div>

        {/* Volume Test */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-accent-foreground uppercase tracking-wide">
            Volume Test
          </h2>
          <div className="flex flex-wrap gap-2">
            {[0.1, 0.25, 0.5, 0.75, 1.0].map((volume) => {
              const playSound = useAudioStore.getState().playSound
              return (
                <button
                  key={volume}
                  onClick={() => playSound("chime1", { volume })}
                  className="px-4 py-2 bg-card hover:bg-accent text-foreground text-sm font-medium border border-border hover:border-accent-foreground transition-colors"
                >
                  {Math.round(volume * 100)}%
                </button>
              )
            })}
          </div>
        </div>

        {/* Instructions */}
        <div className="p-4 bg-card/50 border border-border space-y-2">
          <h3 className="text-sm font-medium text-foreground uppercase">Instructions</h3>
          <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
            <li>Click any sound button to play it</li>
            <li>Open Settings to adjust volume levels for FX, Ambience, and Music</li>
            <li>Toggle mute switches to test enable/disable</li>
            <li>Loop ambience and adjust volume to test real-time changes</li>
          </ul>
        </div>
      </div>

      {/* Settings Modal */}
      <Settings />
    </div>
  )
}

AudioTestStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: false, // Enable audio for this story
}
