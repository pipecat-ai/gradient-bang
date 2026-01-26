import { useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { Dialog } from "radix-ui"

import { CharacterSelect as CharacterSelectComponent } from "@/components/CharacterSelect"
import useGameStore from "@/stores/game"

import { CreateCharacter } from "../CreateCharacter"

export const CharacterSelectDialog = ({
  onCharacterSelect,
}: {
  onCharacterSelect: (characterId: string) => void
}) => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const [isCreatingNewCharacter, setIsCreatingNewCharacter] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  return (
    <Dialog.Root
      open={activeModal === "character_select"}
      onOpenChange={(open) => {
        if (!open) {
          setIsCreatingNewCharacter(false)
          setActiveModal(undefined)
        }
      }}
    >
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {activeModal === "character_select" && (
            <>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                  className="DialogOverlay bg-muted/80 motion-safe:bg-muted/30 motion-safe:backdrop-blur-sm text-subtle dialog-dots"
                />
              </Dialog.Overlay>
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
              >
                <div className="hidden">
                  <Dialog.Title>Select Character</Dialog.Title>
                </div>
                <Dialog.Content
                  forceMount
                  aria-describedby={undefined}
                  className="DialogContent DialogContent-NoPadding w-screen max-h-min"
                  onOpenAutoFocus={(e) => {
                    e.preventDefault()
                    contentRef.current?.focus({ preventScroll: true })
                  }}
                  onCloseAutoFocus={(e) => e.preventDefault()}
                >
                  <div
                    ref={contentRef}
                    tabIndex={-1}
                    className="relative py-ui-md w-full overflow-hidden flex items-center justify-center bg-background/80 border-y shadow-long outline-none"
                  >
                    {isCreatingNewCharacter ?
                      <CreateCharacter
                        onCancel={() => setIsCreatingNewCharacter(false)}
                        onCharacterCreate={(characterId) => {
                          onCharacterSelect(characterId)
                        }}
                      />
                    : <CharacterSelectComponent
                        onCharacterSelect={onCharacterSelect}
                        onIsCreating={() => setIsCreatingNewCharacter(true)}
                      />
                    }
                  </div>
                </Dialog.Content>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
