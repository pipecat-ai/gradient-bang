import { button, buttonGroup, folder, Leva, useControls } from "leva"
import { PipecatClient } from "@pipecat-ai/client-js"

import useGameStore from "@/stores/game"

import { useTaskControls } from "./useTaskControls"

import { SECTOR_MOCK } from "@/mocks/sector.mock"

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

  useControls(() => ({
    ["Connect"]: buttonGroup({
      label: "Connection",
      opts: {
        ["Connect"]: () => client.startBotAndConnect({ endpoint }),
        ["Disconnect"]: () => client.disconnect(),
      },
    }),
    ["Set Sector"]: button(() =>
      setSector({ ...SECTOR_MOCK, id: Math.floor(Math.random() * 100) })
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
  }))

  useTaskControls()

  return <Leva hidden={hidden} />
}
