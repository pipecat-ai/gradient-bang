import { useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { Dialog } from "radix-ui"
import { ArrowRightIcon } from "@phosphor-icons/react"
import { WarningDiamondIcon } from "@phosphor-icons/react"

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/primitives/Table"
import useGameStore from "@/stores/game"
import { formatDate } from "@/utils/date"

const CharacterSelectTile = ({
  character,
  onSelect,
}: {
  character: CharacterSelectResponse
  onSelect: () => void
}) => {
  return (
    <TableRow
      className="text-base hover:bg-muted border-b-border/50"
      onClick={onSelect}
    >
      <TableCell className="font-bold py-4">{character.name}</TableCell>
      <TableCell className="py-5">
        {formatDate(character.last_active)}
      </TableCell>
      <TableCell className="text-right py-4">
        <Button variant="default" size="lg">
          Select <ArrowRightIcon weight="bold" />
        </Button>
      </TableCell>
    </TableRow>
  )
}
export const CharacterSelect = ({
  characters,
  onCharacterSelect,
}: {
  characters: CharacterSelectResponse[]
  onCharacterSelect: (characterId: string) => void
}) => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const [error, setError] = useState<string | null>(null)
  const [newCharacterName, setNewCharacterName] = useState<string>("")
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [isCreatingNewCharacter, setIsCreatingNewCharacter] = useState(false)
  const accessToken = useGameStore.use.access_token?.()
  const inputRef = useRef<HTMLInputElement>(null)

  const handleCreateNewCharacter = async () => {
    console.debug("[GAME] Creating new character:", newCharacterName)
    setIsLoading(true)
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SERVER_URL}/user_character_create`,
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
      onCharacterSelect(data.character_id)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Failed to create character"
      )
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Dialog.Root
      open={activeModal === "character_select"}
      onOpenChange={() => setActiveModal(undefined)}
    >
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {activeModal === "character_select" && (
            <Dialog.Overlay asChild forceMount>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                className="DialogOverlay bg-muted/80 motion-safe:bg-muted/30 motion-safe:backdrop-blur-sm bg-dotted-lg bg-dotted-white/10 bg-center"
              >
                <Dialog.Title>Select Character</Dialog.Title>
                <Dialog.Content
                  asChild
                  forceMount
                  aria-describedby={undefined}
                  className="DialogContent max-w-2xl"
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                  >
                    <Card
                      elbow={true}
                      size="default"
                      className="w-full bg-black shadow-2xl"
                    >
                      <CardHeader>
                        <CardTitle className="heading-2">
                          {isCreatingNewCharacter
                            ? "Create New Character"
                            : "Character Select"}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="overflow-x-clip">
                        <AnimatePresence mode="wait">
                          {isCreatingNewCharacter ? (
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
                                    <WarningDiamondIcon
                                      className="size-6 text-destructive"
                                      weight="duotone"
                                    />
                                    <span className="text-sm uppercase bg-background/40 tracking-wider font-medium">
                                      {error}
                                    </span>
                                  </CardContent>
                                </Card>
                              )}
                              <div className="flex flex-row gap-6">
                                <div className="bg-dotted-sm bg-dotted-white/30 w-24" />
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
                                <div className="bg-dotted-sm bg-dotted-white/30 w-24" />
                              </div>
                            </motion.div>
                          ) : (
                            <motion.div
                              key="idle"
                              initial={{ x: -50, opacity: 0 }}
                              animate={{ x: 0, opacity: 1 }}
                              exit={{ x: -50, opacity: 0 }}
                              transition={{
                                duration: 0.2,
                                ease: "easeInOut",
                              }}
                              className="w-full flex flex-col gap-5"
                            >
                              <Table className="text-xs">
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Player Name</TableHead>
                                    <TableHead>Last Active</TableHead>
                                    <TableHead />
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {characters
                                    .filter((character) => !character.is_npc)
                                    .map((character) => (
                                      <CharacterSelectTile
                                        key={character.character_id}
                                        character={character}
                                        onSelect={() =>
                                          onCharacterSelect(
                                            character.character_id
                                          )
                                        }
                                      />
                                    ))}
                                </TableBody>
                              </Table>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </CardContent>
                      <CardFooter className="flex flex-col gap-6 mt-4">
                        <Divider decoration="plus" />
                        <div className="flex flex-row gap-3 w-full">
                          <Button
                            onClick={() => setActiveModal(undefined)}
                            variant="secondary"
                            className="flex-1"
                          >
                            Close
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              if (isCreatingNewCharacter) {
                                setIsCreatingNewCharacter(false)
                              } else {
                                setIsCreatingNewCharacter(true)
                              }
                            }}
                            className="flex-1"
                          >
                            {!isCreatingNewCharacter
                              ? "Create New Character"
                              : "Back to Character Select"}
                          </Button>
                        </div>
                      </CardFooter>
                    </Card>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
