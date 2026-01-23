import { button, folder, useControls } from "leva"
import { faker } from "@faker-js/faker"
import type { Story } from "@ladle/react"

import { PlayerShipPanel } from "@/components/panels/PlayerShipPanel"
import { useGameContext } from "@/hooks/useGameContext"
import useGameStore from "@/stores/game"

import { SHIP_MOCK } from "@/mocks/ship.mock"

export const PlayerShipStory: Story = () => {
  const { dispatchAction } = useGameContext()
  const setShips = useGameStore.use.setShips()

  useControls(() => ({
    Ships: folder(
      {
        ["Get My Ships"]: button(() => {
          dispatchAction({
            type: "get-my-ships",
            async: true,
          })
        }),
        ["TEST: Add Mock Ship"]: button(() => {
          const s = useGameStore.getState().ships ?? []
          setShips([
            ...(s.data ?? []),
            {
              ...SHIP_MOCK,
              id: faker.string.uuid(),
              ship_id: faker.string.uuid(),
              name: faker.vehicle.vehicle(),
              ship_type: faker.vehicle.type(),
              sector: faker.number.int(5000),
            } as ShipSummary,
          ])
        }),
        ["TEST: Reset Ships"]: button(() => {
          setShips([])
        }),
      },
      { collapsed: false }
    ),
  }))

  return (
    <>
      <div className="min-h-64">
        <PlayerShipPanel />
      </div>
    </>
  )
}

PlayerShipStory.meta = {
  useDevTools: true,
}
