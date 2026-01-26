import { useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { WarningDiamondIcon } from "@phosphor-icons/react"

import { Button } from "@/components/primitives/Button"
import { Card, CardContent } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import { Input } from "@/components/primitives/Input"
import useGameStore from "@/stores/game"

export const CreateCharacter = ({
  onCharacterCreate,
  onCancel,
}: {
  onCancel: () => void
  onCharacterCreate: (characterId: string) => void
}) => {
  const [error, setError] = useState<string | null>(null)
  const [newCharacterName, setNewCharacterName] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const accessToken = useGameStore.use.access_token?.()
  const inputRef = useRef<HTMLInputElement>(null)

  const handleCreateNewCharacter = async () => {
    console.debug("[GAME] Creating new character:", newCharacterName)
    setIsLoading(true)
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SERVER_URL || "http://localhost:54321/functions/v1"}/user_character_create`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            name: newCharacterName,
          }),
        }
      )
      if (!response.ok) {
        const data = await response.json()
        inputRef.current?.focus()
        throw new Error(data.error)
      }
      const data = await response.json()
      onCharacterCreate(data.character_id)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to create character")
    }
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="overflow-x-clip">
        <AnimatePresence mode="wait">
          <motion.div
            key="creating-new-character"
            initial={{ x: -50, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -50, opacity: 0 }}
            transition={{
              duration: 0.2,
              ease: "easeInOut",
            }}
            className="w-full flex flex-col gap-5"
          >
            {error && (
              <Card
                variant="stripes"
                size="sm"
                className="bg-destructive/10 stripe-frame-2 stripe-frame-destructive animate-in motion-safe:fade-in-0 motion-safe:duration-1000"
              >
                <CardContent className="flex flex-col gap-2">
                  <WarningDiamondIcon className="size-6 text-destructive" weight="duotone" />
                  <span className="text-sm uppercase bg-background/40 tracking-wider font-medium">
                    {error}
                  </span>
                </CardContent>
              </Card>
            )}
            <div className="flex flex-row gap-4">
              <div className="dotted-bg-md dotted-bg-accent w-30" />
              <form className="flex flex-1 flex-col gap-4">
                <Input
                  ref={inputRef}
                  type="text"
                  placeholder="Enter Character Name"
                  className="text-center"
                  size="xl"
                  value={newCharacterName}
                  onChange={(e) => {
                    setNewCharacterName(e.target.value)
                  }}
                />
                <Button
                  type="submit"
                  variant="default"
                  size="xl"
                  onClick={handleCreateNewCharacter}
                  isLoading={isLoading}
                  loader="stripes"
                  disabled={!newCharacterName || isLoading}
                >
                  Create
                </Button>
              </form>
              <div className="dotted-bg-md dotted-bg-accent w-30" />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
      <footer className="flex flex-col gap-4 mt-4">
        <Divider color="secondary" decoration="none" />
        <div className="flex flex-row gap-3 w-full">
          <Button
            variant="secondary"
            onClick={() => {
              onCancel()
            }}
            className="flex-1"
          >
            Back to Character Select
          </Button>
        </div>
      </footer>
    </div>
  )
}
