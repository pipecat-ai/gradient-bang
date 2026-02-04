import { useState } from "react"

import { CheckIcon, CopyIcon, WarningDiamondIcon } from "@phosphor-icons/react"
import { useCopyToClipboard } from "@uidotdev/usehooks"

import { Button } from "@/components/primitives/Button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import { Input } from "@/components/primitives/Input"
import { Separator } from "@/components/primitives/Separator"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

export const Signup = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const [characterName, setCharacterName] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<boolean>(false)
  const [data, setData] = useState<{ character_id: string } | null>(null)
  const [copiedText, copyToClipboard] = useCopyToClipboard()
  const hasCopiedText = Boolean(copiedText)

  const handleCreateCharacter = async () => {
    console.log("[SIGNUP] Looking up character:", characterName)
    setIsLoading(true)
    setError(false)
    setData(null)

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1"}/player`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: characterName,
          }),
        }
      )
      if (!response.ok) {
        throw new Error("Failed to create character")
      }
      const data = await response.json()
      setData(data)
      console.log("[SIGNUP] Character data:", data)
    } catch (error) {
      setError(true)
      console.error("[SIGNUP] Error looking up character:", error)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <BaseDialog
      modalName="signup"
      title="Signup"
      size="xl"
      overlayVariant="dotted"
    >
      <Card elbow={true} size="default" className="w-full bg-black shadow-2xl">
        <CardHeader>
          <CardTitle className="heading-2">Create Playtest Account</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {error && (
            <Card
              variant="stripes"
              size="sm"
              className="bg-destructive/10 stripe-frame-2 stripe-frame-destructive animate-in motion-safe:fade-in-0 motion-safe:duration-1000"
            >
              <CardContent className="flex flex-col h-full justify-between items-center gap-1">
                <p className="uppercase text-sm tracking-wider">
                  Failed to create character
                </p>
              </CardContent>
            </Card>
          )}
          <Card
            variant="stripes"
            size="sm"
            className="stripe-frame-warning/30 stripe-frame-2 stripe-frame-size-2 border-none bg-warning/10 w-full"
          >
            <CardContent className="flex flex-col gap-2">
              <WarningDiamondIcon
                className="size-6 text-warning"
                weight="duotone"
              />
              <span className="text-sm uppercase animate-pulse bg-background/40 tracking-wider font-medium">
                Do not lose your character ID! Otherwise, you may lose your ship
                to the depths of space forever.
              </span>
            </CardContent>
          </Card>
        </CardContent>
        <CardContent className="flex flex-col gap-6">
          {!data ? (
            <>
              <Input
                placeholder="Enter character name e.g. 'Malcom Reynolds'"
                className="w-full"
                size="xl"
                value={characterName}
                maxLength={50}
                onChange={(e) => setCharacterName(e.target.value)}
              />
              <Button
                onClick={handleCreateCharacter}
                isLoading={isLoading}
                className="w-full"
                loader="stripes"
                size="xl"
                disabled={!characterName || isLoading}
              >
                Create
              </Button>
            </>
          ) : (
            <Card
              variant="stripes"
              size="sm"
              className="bg-success/10 stripe-frame-2 stripe-frame-success animate-in motion-safe:fade-in-0 motion-safe:duration-1000"
            >
              <CardContent className="flex flex-col h-full justify-between items-center gap-3">
                <p className="uppercase text-sm tracking-wider">Character ID:</p>
                <div className="flex flex-row gap-2">
                  <p className="text-success-foreground font-bold text-lg px-2 py-1 bg-success/10">
                    {data.character_id}
                  </p>
                  <Button
                    onClick={() => copyToClipboard(data.character_id)}
                    variant="ghost"
                    size="icon"
                  >
                    {hasCopiedText ? (
                      <CheckIcon className="size-4" weight="bold" />
                    ) : (
                      <CopyIcon className="size-4" weight="bold" />
                    )}
                  </Button>
                </div>

                <Separator className="w-full" variant="dotted" />
                <p className="text-xs text-success-foreground font-bold">
                  Keep this secret, or others can claim your ship!
                </p>
              </CardContent>
            </Card>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-6">
          <Divider decoration="plus" />
          <div className="flex flex-row gap-3 w-full">
            <Button
              onClick={() => setActiveModal(undefined)}
              variant="secondary"
              className="flex-1"
            >
              Close
            </Button>
          </div>
        </CardFooter>
      </Card>
    </BaseDialog>
  )
}
