import { useState } from "react"

import { FireIcon, type Icon, SkullIcon, SmileyIcon, SmileyXEyesIcon } from "@phosphor-icons/react"

import { BaseDialog } from "@/components/dialogs/BaseDialog"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import { Textarea } from "@/components/primitives/Textarea"
import { useCaptureStore } from "@/stores/captureStore"
import useGameStore from "@/stores/game"

const MOODS: { value: string; label: string; icon: Icon }[] = [
  { value: "exciting", label: "Exciting", icon: FireIcon },
  { value: "funny", label: "Funny", icon: SmileyIcon },
  { value: "dramatic", label: "Dramatic", icon: SkullIcon },
  { value: "unhinged", label: "Unhinged AI", icon: SmileyXEyesIcon },
]

export const SocialReplayDialog = () => {
  const capture = useCaptureStore((s) => s.capture)
  const [description, setDescription] = useState("")
  const [mood, setMood] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const setActiveModal = useGameStore.use.setActiveModal()

  const handleSave = async () => {
    if (!capture) return
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
    <BaseDialog size="xl" modalName="social_replay" title="Save Replay" overlayVariant="dots">
      <Card elbow={true} size="default" className="w-full h-full max-h-max bg-black shadow-2xl">
        <CardHeader>
          <CardTitle className="heading-2">Capture replay</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-md">
          <p className="text-xs text-subtle-foreground leading-normal">
            Save the last 90 seconds of gameplay and audio in a shareable format. This will download
            a JSON file that can be uploaded to the replay system accessible from the title screen.
          </p>
          <Textarea
            placeholder="What just happened?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full h-32"
          />

          <div className="flex flex-col gap-ui-xs">
            <span className="text-xs text-muted-foreground uppercase">Mood</span>
            <div className="flex gap-ui-xs">
              {MOODS.map((m) => (
                <Button
                  key={m.value}
                  variant={mood === m.value ? "default" : "secondary"}
                  size="sm"
                  onClick={() => setMood(mood === m.value ? undefined : m.value)}
                  className="capitalize text-xs"
                >
                  <m.icon size={14} /> {m.label}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-6">
          <Divider decoration="plus" color="accent" />
          <div className="flex flex-row gap-3 w-full">
            <Button
              onClick={() => setActiveModal(undefined)}
              variant="secondary"
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={handleSave}
              disabled={saving || !capture}
              className="flex-1"
            >
              {saving ? "Saving..." : "Save Clip"}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </BaseDialog>
  )
}
