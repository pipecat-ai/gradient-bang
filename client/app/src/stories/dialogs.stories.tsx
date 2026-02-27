import type { Story } from "@ladle/react"

import { CharacterSelectDialog } from "@/components/dialogs/CharacterSelect"
import { Leaderboard } from "@/components/dialogs/Leaderboard"
import { Settings } from "@/components/dialogs/Settings"
import { Signup } from "@/components/dialogs/Signup"
import { Button } from "@/components/primitives/Button"
import useGameStore from "@/stores/game"

export const AllDialogs: Story = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground uppercase tracking-wider">
            Dialog Components
          </h1>
          <p className="text-sm text-muted-foreground">
            Click any button to open a modal dialog
          </p>
          {activeModal?.modal && (
            <p className="text-xs text-accent-foreground">
              Active modal: <code className="bg-card px-2 py-1">{activeModal.modal}</code>
            </p>
          )}
        </div>

        {/* Dialog Triggers */}
        <div className="grid grid-cols-2 gap-4">
          <Button
            onClick={() => setActiveModal("settings")}
            variant="secondary"
            className="w-full"
          >
            Open Settings
          </Button>
          <Button
            onClick={() => setActiveModal("leaderboard")}
            variant="secondary"
            className="w-full"
          >
            Open Leaderboard
          </Button>
          <Button
            onClick={() => setActiveModal("signup")}
            variant="secondary"
            className="w-full"
          >
            Open Signup
          </Button>
          <Button
            onClick={() => setActiveModal("character_select")}
            variant="secondary"
            className="w-full"
          >
            Open Character Select
          </Button>
        </div>

        {/* Instructions */}
        <div className="p-4 bg-card/50 border border-border space-y-2">
          <h3 className="text-sm font-medium text-foreground uppercase">
            Testing Notes
          </h3>
          <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
            <li>All dialogs should have a close button in the top-right</li>
            <li>Clicking the overlay should close the dialog</li>
            <li>ESC key should close the dialog</li>
            <li>Animations should be smooth on open/close</li>
            <li>Settings uses the "dots" overlay pattern</li>
            <li>Signup uses the "dotted" overlay pattern</li>
          </ul>
        </div>
      </div>

      {/* Render all dialogs */}
      <Settings />
      <Leaderboard />
      <Signup />
      <CharacterSelectDialog onCharacterSelect={(id) => console.log("Selected:", id)} />
    </div>
  )
}

AllDialogs.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}
