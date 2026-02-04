import { useRef, useState } from "react"

import { CharacterSelect as CharacterSelectComponent } from "@/components/CharacterSelect"
import { CreateCharacter } from "@/components/CreateCharacter"

import { BaseDialog } from "./BaseDialog"

export const CharacterSelectDialog = ({
  onCharacterSelect,
}: {
  onCharacterSelect: (characterId: string) => void
}) => {
  const [isCreatingNewCharacter, setIsCreatingNewCharacter] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const handleClose = () => {
    setIsCreatingNewCharacter(false)
  }

  return (
    <BaseDialog
      modalName="character_select"
      title="Select Character"
      size="full"
      noPadding
      contentClassName="max-h-min"
      onClose={handleClose}
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
        {isCreatingNewCharacter ? (
          <CreateCharacter
            onCancel={() => setIsCreatingNewCharacter(false)}
            onCharacterCreate={(characterId) => {
              onCharacterSelect(characterId)
            }}
          />
        ) : (
          <CharacterSelectComponent
            onCharacterSelect={onCharacterSelect}
            onIsCreating={() => setIsCreatingNewCharacter(true)}
          />
        )}
      </div>
    </BaseDialog>
  )
}
