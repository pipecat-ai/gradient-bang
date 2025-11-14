import { useEffect } from "react"

import type { Story } from "@ladle/react"

import { Button } from "@/components/primitives/Button"
import { TopBar } from "@/hud/TopBar"
import useGameStore from "@/stores/game"

export const TopBarStory: Story = () => {
  const setShip = useGameStore.use.setShip()
  const ship = useGameStore.use.ship()

  useEffect(() => {
    setShip({
      warp_power: 100,
      warp_power_capacity: 100,
      shields: 100,
      max_shields: 100,
      fighters: 100,
      max_fighters: 100,
      cargo: {
        quantum_foam: 0,
        retro_organics: 0,
        neuro_symbolics: 0,
      },
      cargo_capacity: 100,
      empty_holds: 100,
    })
  }, [setShip])

  return (
    <div className="relative w-full h-screen bg-gray-500">
      <TopBar />

      <div className="flex flex-col gap-2">
        <Button
          onClick={() => {
            setShip({ warp_power: ship.warp_power + 10 })
          }}
        >
          Increment Fuel
        </Button>
        <Button
          onClick={() => {
            setShip({ warp_power: ship.warp_power - 10 })
          }}
        >
          Decrement Fuel
        </Button>
        <Button
          onClick={() => {
            setShip({ shields: ship.shields! + 10 })
          }}
        >
          Increment Shields
        </Button>
        <Button
          onClick={() => {
            setShip({ shields: ship.shields! - 10 })
          }}
        >
          Decrement Shields
        </Button>
        <Button
          onClick={() => {
            setShip({
              ...ship,
              cargo: {
                ...ship.cargo,
                retro_organics: (ship.cargo.retro_organics ?? 0) + 1,
              },
              empty_holds: ship.empty_holds - 1,
            })
          }}
        >
          Increment RO + 1
        </Button>
        <Button
          onClick={() => {
            setShip({
              ...ship,
              cargo: {
                ...ship.cargo,
                retro_organics: (ship.cargo.retro_organics ?? 0) - 1,
              },
              empty_holds: ship.empty_holds + 1,
            })
          }}
        >
          Decrement RO - 1
        </Button>
        <Button
          onClick={() => {
            setShip({
              ...ship,
              credits: (ship.credits ?? 0) + 1000,
            })
          }}
        >
          Incremenet Credits + 1000
        </Button>
        <Button
          onClick={() => {
            setShip({
              ...ship,
              credits: (ship.credits ?? 0) - 1000,
            })
          }}
        >
          Decrement Credits - 1000
        </Button>
      </div>
    </div>
  )
}
