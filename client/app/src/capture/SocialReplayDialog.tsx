import { useState } from "react"

import { BaseDialog } from "@/components/dialogs/BaseDialog"
import { Button } from "@/components/primitives/Button"
import useGameStore from "@/stores/game"

import type { SocialReplayCapture } from "./SocialReplayCapture"

const MOODS = ["exciting", "funny", "dramatic", "intense"] as const

export const SocialReplayDialog = ({ capture }: { capture: SocialReplayCapture }) => {
  const [description, setDescription] = useState("")
  const [mood, setMood] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const setActiveModal = useGameStore.use.setActiveModal()

  const handleSave = async () => {
    setSaving(true)
    try {
      await capture.download({ description, mood })
      setActiveModal(undefined)
      setDescription("")
      setMood(undefined)
    } finally {
      setSaving(false)
    }
  }

  return (
    <BaseDialog modalName="social_replay" title="Save Replay" size="sm" overlayVariant="dots">
      <div className="flex flex-col gap-ui-md p-ui-md bg-background border border-border">
        <h2 className="text-sm font-bold uppercase text-subtle-foreground">Save Replay</h2>

        <input
          type="text"
          placeholder="What just happened?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-subtle-background border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-terminal"
        />

        <div className="flex flex-col gap-ui-xs">
          <span className="text-xs text-muted-foreground uppercase">Mood</span>
          <div className="flex gap-ui-xs">
            {MOODS.map((m) => (
              <Button
                key={m}
                variant={mood === m ? "default" : "secondary"}
                size="sm"
                onClick={() => setMood(mood === m ? undefined : m)}
                className="capitalize text-xs"
              >
                {m}
              </Button>
            ))}
          </div>
        </div>

        <Button variant="default" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Clip"}
        </Button>
      </div>
    </BaseDialog>
  )
}
