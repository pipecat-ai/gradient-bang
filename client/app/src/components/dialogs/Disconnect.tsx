import { RTVIEvent } from "@pipecat-ai/client-js"
import { useRTVIClientEvent } from "@pipecat-ai/client-react"

import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

export const Disconnect = () => {
  const setActiveModal = useGameStore.use.setActiveModal()

  useRTVIClientEvent(RTVIEvent.Disconnected, () => {
    setActiveModal("disconnect")
  })

  useRTVIClientEvent(RTVIEvent.BotDisconnected, () => {
    setActiveModal("disconnect")
  })

  return (
    <BaseDialog modalName="disconnect" title="Disconnect" size="2xl">
      <Card
        variant="stripes"
        size="default"
        className="w-full h-fit shadow-2xl stripe-frame-destructive bg-background"
      >
        <CardHeader>
          <CardTitle>Disconnected</CardTitle>
        </CardHeader>
        <CardContent className="h-full min-h-0 text-sm">
          You have been disconnected from the game. This could be due to a network issue or the
          server being unavailable. Please check your connection and try again.
        </CardContent>
        <CardFooter className="flex flex-col gap-6">
          <Divider decoration="plus" color="accent" />
          <div className="flex flex-row gap-3 w-full">
            <Button onClick={() => window.location.reload()} className="flex-1">
              Reconnect
            </Button>
          </div>
        </CardFooter>
      </Card>
    </BaseDialog>
  )
}
