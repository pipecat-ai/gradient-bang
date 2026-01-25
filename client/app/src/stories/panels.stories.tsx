import { button, folder, useControls } from "leva"
import { faker } from "@faker-js/faker"
import type { Story } from "@ladle/react"

import { MiniMapPanel } from "@/components/panels/MiniMapPanel"
import { PlayerShipPanel } from "@/components/panels/PlayerShipPanel"
import { useGameContext } from "@/hooks/useGameContext"
import useGameStore from "@/stores/game"

import { SHIP_MOCK } from "@/mocks/ship.mock"

export const PlayerShipStory: Story = () => {
  const { dispatchAction } = useGameContext()
  const setShips = useGameStore.use.setShips()
  const getShipSectors = useGameStore.use.getShipSectors()

  useControls(() => ({
    Ships: folder(
      {
        ["Get My Ships"]: button(() => {
          dispatchAction({
            type: "get-my-ships",
            async: true,
          })
        }),
        ["Log Ship Sectors"]: button(() => {
          console.log(getShipSectors(false))
        }),
        ["TEST: Add Mock Ship"]: button(() => {
          const s = useGameStore.getState().ships ?? []
          setShips([
            ...(s.data ?? []),
            {
              ...SHIP_MOCK,
              owner_type: "personal",
              ship_id: faker.string.uuid(),
              ship_name: faker.vehicle.vehicle(),
              ship_type: faker.vehicle.type(),
              sector: faker.number.int(5000),
            } as ShipSelf,
          ])
        }),
        ["TEST: Add Mock Corp Ship"]: button(() => {
          const s = useGameStore.getState().ships ?? []
          setShips([
            ...(s.data ?? []),
            {
              ...SHIP_MOCK,
              ship_id: faker.string.uuid(),
              ship_name: faker.vehicle.vehicle(),
              ship_type: faker.vehicle.type(),
              sector: faker.number.int(5000),
            } as ShipSelf,
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
      <PlayerShipPanel />
    </>
  )
}

PlayerShipStory.meta = {
  useDevTools: true,
  enableMic: false,
}

export const PlayerShipsAndMiniMapStory: Story = () => {
  return (
    <div className="flex flex-row gap-3">
      <PlayerShipPanel className="flex-1 self-start" />
      <div className="w-[440px] h-[440px]">
        <MiniMapPanel />
      </div>
    </div>
  )
}

PlayerShipsAndMiniMapStory.meta = {
  useDevTools: true,
  enableMic: false,
}
