import { useEffect } from "react"

import { button, folder, useControls } from "leva"
import { faker } from "@faker-js/faker"
import type { Story } from "@ladle/react"

import { CharacterSelect } from "@/components/CharacterSelect"
import { SettingsPanel } from "@/components/SettingsPanel"
import { Game } from "@/components/views/Game"
import { Title } from "@/components/views/Title"
import { AnimatedFrame } from "@/fx/frame"
import useGameStore from "@/stores/game"

export const Settings: Story = () => {
  return (
    <>
      <p className="story-description">
        Story shows the settings panel component. Changes are saved to the store when you click
        "Save & Close".
      </p>
      <div className="story-card" style={{ maxWidth: "600px" }}>
        <SettingsPanel />
      </div>
    </>
  )
}

Settings.meta = {
  disconnectedStory: true,
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
}

export const GameViewStory: Story = () => {
  const setGameState = useGameStore.use.setGameState()

  useControls(() => ({
    Game: folder(
      {
        ["Ready State"]: button(() => {
          setGameState("ready")
        }),
      },
      {
        collapsed: true,
        order: -1,
      }
    ),
  }))
  return (
    <div className="relative h-full w-full overflow-hidden">
      <Game />
      <AnimatedFrame />
    </div>
  )
}

GameViewStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}

export const CharacterSelectStory: Story = () => {
  const setCharacters = useGameStore.use.setCharacters()

  useEffect(() => {
    // Add 3 initial mock characters
    setCharacters([
      {
        character_id: faker.string.uuid(),
        name: faker.person.fullName(),
        created_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
        is_npc: false,
      },
      {
        character_id: faker.string.uuid(),
        name: faker.person.fullName(),
        created_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
        is_npc: false,
      },
      {
        character_id: faker.string.uuid(),
        name: faker.person.fullName(),
        created_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
        is_npc: false,
      },
    ])
  }, [setCharacters])

  useControls(() => ({
    ["Add Mock Character"]: button(() => {
      const currentCharacters = useGameStore.getState().characters
      setCharacters([
        ...currentCharacters,
        {
          character_id: faker.string.uuid(),
          name: faker.person.fullName(),
          created_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          is_npc: false,
        },
      ])
    }),
  }))

  return (
    <CharacterSelect
      onIsCreating={() => {
        console.log("Creating character")
      }}
      onCharacterSelect={(characterId) => {
        console.log("Selected character:", characterId)
      }}
    />
  )
}

CharacterSelectStory.meta = {
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
  useDevTools: true,
}

export const TitleViewStory: Story = () => {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <Title
        onViewNext={() => {
          console.log("Viewing next")
        }}
      />
      <AnimatedFrame />
    </div>
  )
}

TitleViewStory.meta = {
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
  useDevTools: true,
}
