import { useEffect, useMemo } from "react"

import { button, folder, useControls } from "leva"
import { faker } from "@faker-js/faker"
import type { Story } from "@ladle/react"

import { CharacterSelect } from "@/components/CharacterSelect"
import { CoursePlotPanel } from "@/components/CoursePlotPanel"
import { Divider } from "@/components/primitives/Divider"
import { SectorMap } from "@/components/SectorMap"
import { SettingsPanel } from "@/components/SettingsPanel"
import { Game } from "@/components/views/Game"
import { WarpBadge } from "@/components/WarpBadge"
import { AnimatedFrame } from "@/fx/frame"
import { useNotificationSound } from "@/hooks/useNotificationSound"
import useGameStore from "@/stores/game"

export const Init: Story = () => {
  const coursePlot = useGameStore.use.course_plot?.()
  const player = useGameStore((state) => state.player)
  const corporation = useGameStore((state) => state.corporation)
  const ship = useGameStore((state) => state.ship)
  const sector = useGameStore((state) => state.sector)
  const localMapData = useGameStore((state) => state.local_map_data)
  const messages = useGameStore.use.messages()
  useNotificationSound()

  // Filter in the component
  const directMessages = useMemo(
    () =>
      messages
        .filter((message) => message.type === "direct")
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [messages]
  )

  // Memoize Map config to prevent unnecessary re-renders
  const mapConfig = useMemo(() => ({ debug: true }), [])

  return (
    <>
      <div className="story-card">
        <div className="story-card">
          <h3 className="story-heading">Player:</h3>
          {player && (
            <ul className="story-value-list">
              {Object.entries(player).map(([key, value]) => (
                <li key={key}>
                  <span>{key}</span> <span>{value?.toString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="story-card">
          <h3 className="story-heading">Corporation:</h3>
          {corporation && (
            <ul className="story-value-list">
              {Object.entries(corporation).map(([key, value]) => (
                <li key={key}>
                  <span>{key}</span> <span>{value?.toString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="story-card">
          <h3 className="story-heading">Ship:</h3>
          {ship && (
            <ul className="story-value-list">
              {Object.entries(ship).map(([key, value]) => (
                <li key={key}>
                  <span className="flex-1">{key}</span>
                  <span className="flex-1">
                    {typeof value === "object" ? JSON.stringify(value) : value?.toString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <WarpBadge />

        <h3 className="story-heading">Sector:</h3>
        {sector && (
          <ul className="story-value-list">
            {Object.entries(sector).map(([key, value]) => (
              <li key={key}>
                <span className="flex-1">{key}</span>
                <span className="flex-1">
                  {typeof value === "object" ? JSON.stringify(value) : value?.toString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="story-card bg-card">
          <h3 className="story-heading">Local Area Map:</h3>
          <ul className="story-value-list">
            <li>Sectors visited: {player?.sectors_visited}</li>
            <li>Universe size: {player?.universe_size}</li>
          </ul>
          {sector && localMapData && (
            <div className="w-[440px] h-[520px]">
              <SectorMap
                current_sector_id={sector.id}
                map_data={localMapData}
                width={440}
                height={440}
                maxDistance={2}
                config={mapConfig}
                coursePlot={coursePlot}
              />
            </div>
          )}
          <Divider />
          <CoursePlotPanel />
        </div>

        <div className="story-card bg-card">
          <h3 className="story-heading">Chat messages:</h3>
          {directMessages.map((message) => (
            <div key={message.id}>{JSON.stringify(message)}</div>
          ))}
        </div>
      </div>
    </>
  )
}

Init.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  useDevTools: true,
}

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
