import { useRef, useState } from "react"

import { CharacterSelect as CharacterSelectComponent } from "@/components/CharacterSelect"
import { CreateCharacter } from "@/components/CreateCharacter"

import { BaseDialog } from "./BaseDialog"

export const CharacterSelectDialog = ({
  onCharacterSelect,
}: {
  onCharacterSelect: (characterId: string, isNewCharacter: boolean) => void
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
      dismissOnClickOutside={false}
      playOpenSound={false}
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
        className="relative py-ui-md w-full overflow-y-hidden overflow-x-auto md:overflow-x-hidden flex items-center justify-start md:justify-center bg-background/80 border-y shadow-long outline-none"
      >
        {isCreatingNewCharacter ?
          <CreateCharacter
            onCancel={() => setIsCreatingNewCharacter(false)}
            onCharacterCreate={(characterId) => {
              onCharacterSelect(characterId, true)
            }}
          />
        : <CharacterSelectComponent
            onCharacterSelect={(characterId) => onCharacterSelect(characterId, false)}
            onIsCreating={() => setIsCreatingNewCharacter(true)}
          />
        }
      </div>
    </BaseDialog>
  )
}
