import { button, buttonGroup, folder, Leva, useControls } from "leva"
import { faker } from "@faker-js/faker"
import { PipecatClient } from "@pipecat-ai/client-js"

import useGameStore from "@/stores/game"

import { useChatControls } from "./useChatControls"
import { useMapControls } from "./useMapControls"
import { useTaskControls } from "./useTaskControls"

import { INCOMING_CHAT_TOOL_CALL_MOCK } from "@/mocks/chat.mock"
import { MEGA_PORT_MOCK, PORT_MOCK, SECTOR_MOCK } from "@/mocks/sector.mock"
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

  useControls(() => ({
    ["Connect"]: buttonGroup({
      label: "Connection",
      opts: {
        ["Connect"]: () => client.startBotAndConnect({ endpoint }),
        ["Disconnect"]: () => client.disconnect(),
      },
    }),
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
    ["Set ID"]: {
      value: 1,
      step: 1,
      onChange: (value) => {
        setSector({ ...SECTOR_MOCK, id: value, position: [0, 0], port: MEGA_PORT_MOCK } as Sector)
      },
    },

    ["Look Around"]: button(() => {
      const lookMode = useGameStore.getState().lookMode
      useGameStore.getState().setLookMode(!lookMode)
    }),

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

    Messages: folder(
      {
        ["Get My Status"]: button(() => dispatchAction({ type: "get-my-status" })),
        ["Get Known Port List"]: button(() => dispatchAction({ type: "get-known-ports" })),
      },
      { collapsed: true, order: 0 }
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
      },
      { collapsed: true, order: 1 }
    ),

    Player: folder(
      {
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
      },
      { collapsed: true, order: 2 }
    ),
  }))

  useTaskControls()
  useMapControls()
  useChatControls()

  return <Leva hidden={hidden} />
}
