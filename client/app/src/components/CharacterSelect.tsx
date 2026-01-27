import { useMemo, useRef, useState } from "react"

import { formatDistanceToNow } from "date-fns"
import { AnimatePresence, motion } from "motion/react"
import { PlusIcon, UserIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"

import { Card, CardContent } from "./primitives/Card"

const CharacterCard = ({
  character,
  index,
  onSelect,
}: {
  character: CharacterSelectResponse
  index: number
  onSelect: (characterId: string) => void
}) => {
  const lastActiveString = useMemo(
    () => formatDistanceToNow(new Date(character.last_active), { addSuffix: true }),
    [character.last_active]
  )
  return (
    <motion.div
      className="h-full cursor-pointer"
      initial={{ width: 0 }}
      animate={{ width: 192 }}
      exit={{ width: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
    >
      <motion.div
        tabIndex={0}
        role="button"
        className="interactive-card group bg-card focus-outline focus-hover relative py-0 border h-full w-48 elbow select-none elbow-offset-1 elbow-subtle-foreground hover:elbow-foreground hover:-elbow-offset-3 focus-visible:-elbow-offset-3 focus-visible:elbow-foreground hover:scale-105 focus-visible:scale-105 transition-transform duration-300 ease-in-out cursor-pointer"
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.95 }}
        transition={{ duration: 0.4, delay: 0.15 + index * 0.1, ease: "easeOut" }}
        onClick={() => onSelect(character.character_id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onSelect(character.character_id)
          }
        }}
      >
        <Card className="h-full text-accent-background dither-mask-md border-0 group-hover:text-accent group-focus-visible:text-accent">
          <CardContent className="flex-1 flex flex-col justify-between h-full">
            <div className="text-accent-foreground group-hover:text-terminal group-focus-visible:text-terminal mb-2 aspect-square flex items-center justify-center bg-background/50 cross-lines-accent-background cross-lines-offset-8">
              <UserIcon
                size={24}
                weight="duotone"
                className="relative size-8 z-10 group-hover:animate-blink group-focus-visible:animate-blink"
              />
            </div>
            <span className="group-hover:text-terminal group-focus-visible:text-terminal text-center relative text-white uppercase text-sm font-medium truncate leading-none">
              {character.name}
            </span>
            <span className="text-center text-xxs text-accent-foreground mx-auto truncate">
              <span className="truncate">{lastActiveString}</span>
            </span>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  )
}

export const CharacterSelect = ({
  onCharacterSelect,
  onIsCreating,
}: {
  onCharacterSelect: (characterId: string) => void
  onIsCreating: () => void
}) => {
  const characters = useGameStore.use.characters()
  const [hoverEnabled, setHoverEnabled] = useState(false)
  const hasMovedRef = useRef(false)

  const handleMouseMove = () => {
    if (!hasMovedRef.current) {
      hasMovedRef.current = true
      setHoverEnabled(true)
    }
  }

  return (
    <div className="flex flex-row gap-3 h-64" onMouseMove={handleMouseMove}>
      <div className={`contents ${!hoverEnabled ? "*:pointer-events-none" : ""}`}>
        {characters?.length > 0 && (
          <div className="flex flex-row gap-3 h-full focus-disables-hover">
            <AnimatePresence>
              {characters.map((character, index) => (
                <CharacterCard
                  key={character.character_id}
                  character={character}
                  index={index}
                  onSelect={onCharacterSelect}
                />
              ))}
            </AnimatePresence>
          </div>
        )}

        {characters?.length > 0 && <div className="w-3 dashed-bg-vertical dashed-bg-muted" />}
        <div className="group bg-card focus-outline focus-hover relative py-0 border w-48 elbow select-none elbow-offset-1 elbow-subtle-foreground hover:elbow-foreground hover:-elbow-offset-3 focus-visible:-elbow-offset-3 hover:scale-105 focus-visible:scale-105 transition-transform duration-300 ease-in-out cursor-pointer">
          <Card className="w-full h-full border-0" onClick={onIsCreating}>
            <CardContent className="flex flex-col items-center justify-center w-full h-full gap-4">
              <PlusIcon
                size={24}
                className="relative size-8 z-10 group-hover:text-terminal group-hover:animate-blink"
              />
              <span className="group-hover:text-terminal text-center relative text-white uppercase text-sm font-medium truncate leading-none">
                New Character
              </span>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
