import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

export const IntroTutorial = ({ onContinue }: { onContinue: () => void }) => {
  const setActiveModal = useGameStore.use.setActiveModal()

  const handleSkip = () => {
    setActiveModal(undefined)
    onContinue()
  }

  return (
    <BaseDialog
      modalName="intro_tutorial"
      title="Welcome"
      size="2xl"
      dismissOnClickOutside={false}
      showCloseButton={false}
    >
      <Card variant="stripes" size="default" className="w-full h-fit shadow-xlarge bg-background">
        <CardHeader>
          <CardTitle>Welcome to Gradient Bang</CardTitle>
        </CardHeader>
        <CardContent className="h-full min-h-0 text-sm flex flex-col gap-3">
          <p>
            This is the intro tutorial placeholder. Short 15 second intro video coming soon. For
            now, just know that you&apos;re about to enter a universe where AI agents drive
            everything.
          </p>
          <ul className="list-disc list-inside">
            <li>Why we made this and relevance to Pipecat</li>
            <li>Emphasis on audio and voice - enable your mic!</li>
            <li>How to interact with the ship AI</li>
          </ul>
          <p>Good luck out there, pilot.</p>
        </CardContent>
        <CardFooter className="flex flex-col gap-6">
          <Divider decoration="plus" color="accent" />
          <div className="flex flex-row gap-3 w-full">
            <Button variant="ghost" size="sm" onClick={handleSkip}>
              Skip
            </Button>
          </div>
        </CardFooter>
      </Card>
    </BaseDialog>
  )
}
