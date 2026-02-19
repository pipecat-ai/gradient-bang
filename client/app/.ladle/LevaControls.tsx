import { useRef } from "react"

import { button, buttonGroup, folder, Leva, useControls } from "leva"
import { faker } from "@faker-js/faker"
import { PipecatClient } from "@pipecat-ai/client-js"

import useGameStore from "@/stores/game"

import { useCombatControls } from "./combat/useCombatControls"
import { useChatControls } from "./useChatControls"
import { useMapControls } from "./useMapControls"
import { useTaskControls } from "./useTaskControls"
import { useTradeControls } from "./useTradeControls"

import { SHIP_DEFINITIONS } from "@/types/ships"
import { INCOMING_CHAT_TOOL_CALL_MOCK } from "@/mocks/chat.mock"
import { LEADERBOARD_DATA_MOCK } from "@/mocks/misc.mock"
import {
  createRandomCorporation,
  createRandomPlayer,
  createRandomUnownedShip,
  MEGA_PORT_MOCK,
  PLAYER_MOVEMENT_HISTORY_MOCK,
  PORT_MOCK,
  SECTOR_FULL_MOCK,
  SECTOR_MOCK,
} from "@/mocks/sector.mock"
import { SHIP_MOCK } from "@/mocks/ship.mock"

export const LevaControls = ({
  client,
  endpoint,
  hidden,
}: {
  client: PipecatClient
  endpoint: string
  hidden: boolean
}) => {
  const dispatchAction = useGameStore.use.dispatchAction()
  const addToast = useGameStore.use.addToast()
  const setSector = useGameStore.use.setSector()
  const addChatMessage = useGameStore.use.addChatMessage()
  const addSectorPlayer = useGameStore.use.addSectorPlayer()
  const removeSectorPlayer = useGameStore.use.removeSectorPlayer()
  const addActivityLogEntry = useGameStore.use.addActivityLogEntry()
  const updateSector = useGameStore.use.updateSector()
  const setCorporation = useGameStore.use.setCorporation()

  const isFirstRender = useRef(true)

  useControls(() => ({
    ["Connect"]: buttonGroup({
      label: "Connection",
      opts: {
        ["Connect"]: () => client.startBotAndConnect({ endpoint }),
        ["Disconnect"]: () => client.disconnect(),
      },
    }),
    ["Get My Status"]: button(() => dispatchAction({ type: "get-my-status" })),
    ["Set Sector 0"]: button(() =>
      setSector({ ...SECTOR_MOCK, id: 0, position: [0, 0], port: MEGA_PORT_MOCK } as Sector)
    ),
    ["Set Random Sector"]: button(() =>
      setSector({
        ...SECTOR_MOCK,
        id: Math.floor(Math.random() * 100),
        port: Math.random() > 0.5 ? PORT_MOCK : undefined,
      })
    ),
    ["Load Mock Sector"]: button(() => setSector(SECTOR_FULL_MOCK)),
    ["Set ID"]: {
      value: 1,
      step: 1,
      onChange: (value) => {
        if (isFirstRender.current) {
          isFirstRender.current = false
          return
        }
        setSector({ ...SECTOR_MOCK, id: value, position: [0, 0], port: MEGA_PORT_MOCK } as Sector)
      },
    },

    ["Mock Player Self"]: button(() => {
      const state = useGameStore.getState()
      state.setPlayer({
        name: faker.person.fullName(),
        id: "81da8782-7bb1-4f68-9456-76697f249b92",
      })
    }),

    ["Look Around"]: button(() => {
      const lookMode = useGameStore.getState().lookMode
      useGameStore.getState().setLookMode(!lookMode)
    }),

    Ships: folder(
      {
        ["Get My Ships"]: button(() => {
          dispatchAction({
            type: "get-my-ships",
          })
        }),
      },
      { collapsed: true }
    ),

    Conversation: folder(
      {
        ["Add System Message"]: button(() => {
          addChatMessage({
            role: "system",
            parts: [
              {
                text: faker.lorem.words({ min: 2, max: 25 }),
                final: true,
                createdAt: new Date().toISOString(),
              },
            ],
          })
        }),
        ["Add Incoming Tool Call"]: button(() => {
          const state = useGameStore.getState()
          state.addToolCallMessage(INCOMING_CHAT_TOOL_CALL_MOCK.name)
        }),
        ["Set LLM Is Working"]: button(() => {
          const state = useGameStore.getState()
          state.setLLMIsWorking(true)
        }),
        ["Set LLM Is Not Working"]: button(() => {
          const state = useGameStore.getState()
          state.setLLMIsWorking(false)
        }),
      },
      { collapsed: true }
    ),

    Toasts: folder(
      {
        ["Add Bank Withdrawal Toast"]: button(() =>
          addToast({ type: "bank.transaction", meta: { direction: "withdraw", amount: 1000 } })
        ),
        ["Add Bank Deposit Toast"]: button(() =>
          addToast({ type: "bank.transaction", meta: { direction: "deposit", amount: 1000 } })
        ),
        ["Add Fuel Purchased Toast"]: button(() => addToast({ type: "warp.purchase" })),
        ["Add Salvage Collected Toast"]: button(() => addToast({ type: "salvage.collected" })),
        ["Add Salvage Created Toast"]: button(() => addToast({ type: "salvage.created" })),
        ["Add Trade Executed Toast"]: button(() => addToast({ type: "trade.executed" })),
        ["Add Transfer Toast"]: button(() => addToast({ type: "transfer" })),
        ["Add Ship Purchased Toast"]: button(() => {
          const def = faker.helpers.arrayElement(SHIP_DEFINITIONS)
          addToast({
            type: "ship.purchased",
            meta: {
              ship: {
                ship_id: faker.string.uuid(),
                ship_name: def.display_name,
                ship_type: def.ship_type,
                fighters: def.fighters,
                shields: def.shields,
              },
            },
          })
        }),
        ["Add Corporation Created Toast"]: button(() => {
          const corp = createRandomCorporation()
          addToast({
            type: "corporation.created",
            meta: { corporation: corp },
          })
        }),
      },
      { collapsed: true, order: 1 }
    ),

    Player: folder(
      {
        ["List known ports"]: button(() => {
          dispatchAction({ type: "get-known-ports" })
        }),
        ["Ship Mock"]: button(() => {
          const setShip = useGameStore.getState().setShip
          setShip({ ...SHIP_MOCK, owner_type: "corporation" })
        }),
        ["Increment Warp Power"]: button(() => {
          const ship = useGameStore.getState().ship
          const setShip = useGameStore.getState().setShip
          const currentWarpPower = ship?.warp_power ?? 0
          const newWarpPower = currentWarpPower + 1
          setShip({ ...ship, warp_power: newWarpPower, warp_power_capacity: 100 })
        }),
        ["Decrement Warp Power"]: button(() => {
          const ship = useGameStore.getState().ship
          const setShip = useGameStore.getState().setShip
          const currentWarpPower = ship?.warp_power ?? 0
          const newWarpPower = currentWarpPower - 1
          setShip({ ...ship, warp_power: newWarpPower, warp_power_capacity: 100 })
        }),
        ["Increment Cargo Capacity"]: button(() => {
          const ship = useGameStore.getState().ship
          const setShip = useGameStore.getState().setShip
          const currentCargoCapacity = ship?.cargo_capacity ?? 100
          const newEmptyHolds = Math.max(0, (ship?.empty_holds ?? currentCargoCapacity) - 10)
          setShip({ ...ship, cargo_capacity: currentCargoCapacity, empty_holds: newEmptyHolds })
        }),
        ["Decrement Cargo Capacity"]: button(() => {
          const ship = useGameStore.getState().ship
          const setShip = useGameStore.getState().setShip
          const currentCargoCapacity = ship?.cargo_capacity ?? 100
          const newEmptyHolds = Math.max(0, (ship?.empty_holds ?? currentCargoCapacity) + 10)
          setShip({ ...ship, cargo_capacity: currentCargoCapacity, empty_holds: newEmptyHolds })
        }),
        ["Increment Credits"]: button(() => {
          const ship = useGameStore.getState().ship
          const setShip = useGameStore.getState().setShip
          const currentCredits = ship?.credits ?? 0
          setShip({ ...ship, credits: currentCredits + 1000 })
        }),
        ["Decrement Credits"]: button(() => {
          const ship = useGameStore.getState().ship
          const setShip = useGameStore.getState().setShip
          const currentCredits = ship?.credits ?? 0
          setShip({ ...ship, credits: currentCredits - 1000 })
        }),
        ["Add Random Player"]: button(() => {
          const player = createRandomPlayer()
          addSectorPlayer(player)
          addActivityLogEntry({
            type: "character.moved",
            message: `[${player.name}] arrived in sector`,
            meta: {
              direction: "arrive",
              player: { id: player.id, name: player.name },
              ship: player.ship,
              silent: true,
            },
          })
        }),

        ["Add Unowned Ship"]: button(() => {
          const sector = useGameStore.getState().sector
          if (!sector) return
          const ship = createRandomUnownedShip()
          updateSector({
            id: sector.id,
            unowned_ships: [...(sector.unowned_ships ?? []), ship],
          })
        }),

        ["Add Mock Salvage"]: button(() => {
          const sector = useGameStore.getState().sector
          if (!sector) return
          const resources: Resource[] = ["neuro_symbolics", "quantum_foam", "retro_organics"]
          const cargo: Partial<Record<Resource, number>> = {}
          // Pick 1-3 random resources with random amounts
          const numResources = Math.floor(Math.random() * 3) + 1
          const shuffled = [...resources].sort(() => Math.random() - 0.5)
          for (let i = 0; i < numResources; i++) {
            cargo[shuffled[i]] = Math.floor(Math.random() * 50) + 5
          }
          const salvageItem: Salvage = {
            salvage_id: faker.string.uuid(),
            source: {
              ship_name: faker.vehicle.vehicle(),
              ship_type: faker.vehicle.type(),
            },
            cargo: cargo as Record<Resource, number>,
            credits: Math.random() > 0.5 ? Math.floor(Math.random() * 5000) + 100 : undefined,
            scrap: Math.random() > 0.5 ? Math.floor(Math.random() * 20) + 1 : undefined,
            claimed: false,
            created_at: new Date().toISOString(),
          }
          updateSector({
            id: sector.id,
            salvage: [...(sector.salvage ?? []), salvageItem],
          })
        }),

        ["Join Corporation"]: button(() => {
          const corp = createRandomCorporation()
          setCorporation(corp)
        }),

        ["Mock Player Arrive"]: button(() => {
          const mockData = PLAYER_MOVEMENT_HISTORY_MOCK
          const name = faker.person.fullName()
          const player = { id: faker.string.uuid(), name: name }
          const ship = {
            ship_id: faker.string.uuid(),
            ship_name: faker.vehicle.vehicle(),
            ship_type: "kestrel_courier",
          }
          addSectorPlayer({
            id: player.id,
            name: name,
            ship: ship,
          })

          addActivityLogEntry({
            type: "character.moved",
            message: `[${name}] arrived in sector`,
            meta: {
              sector: mockData.sector,
              direction: "arrive",
              player,
              ship,
              silent: true,
            },
          })
        }),

        ["Mock Player Depart"]: button(() => {
          const mockData = PLAYER_MOVEMENT_HISTORY_MOCK
          const name = faker.person.fullName()
          const player = { id: faker.string.uuid(), name: name }
          const ship = {
            ship_id: faker.string.uuid(),
            ship_name: faker.vehicle.vehicle(),
            ship_type: "kestrel_courier",
          }
          removeSectorPlayer({
            id: player.id,
            name: player.name,
            ship: ship,
          })
          addActivityLogEntry({
            type: "character.moved",
            message: `[${name}] departed from sector`,
            meta: {
              sector: mockData.sector,
              direction: "depart",
              player,
              ship,
              silent: true,
            },
          })
        }),
      },
      { collapsed: true, order: 2 }
    ),
    Highlight: folder(
      {
        ["Target"]: {
          value: "sector",
          options: {
            Sector: "sector",
            Player: "player",
            Trade: "trade",
            Tasks: "task_history",
            Corp: "corp",
            Waves: "logs",
          },
        },
        ["Highlight Target"]: button((get) => {
          const target = get("Highlight.Target")
          useGameStore.getState().setHighlightElement(target)
        }),
        ["Clear Highlight"]: button(() => {
          useGameStore.getState().setHighlightElement(null)
        }),
      },
      { collapsed: true, order: 3 }
    ),
    Leaderboard: folder(
      {
        ["Set Leaderboard Data"]: button(() => {
          const setLeaderboardData = useGameStore.getState().setLeaderboardData
          setLeaderboardData(LEADERBOARD_DATA_MOCK)
        }),
      },
      { collapsed: true, order: 4 }
    ),
  }))

  useTaskControls()
  useMapControls()
  useChatControls()
  useCombatControls()
  useTradeControls()

  return <Leva hidden={hidden} />
}
