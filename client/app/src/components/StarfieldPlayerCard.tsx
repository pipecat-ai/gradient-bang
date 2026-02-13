import { useClickAway } from "@uidotdev/usehooks"

import { ShipDetailsCallout } from "@/components/ShipDetailsCallout"
import useGameStore from "@/stores/game"

export const StarfieldPlayerCard = () => {
  const playerTargetId = useGameStore.use.playerTargetId()
  const setPlayerTargetId = useGameStore.use.setPlayerTargetId()
  const setLookAtTarget = useGameStore.use.setLookAtTarget()
  const sector = useGameStore((state) => state.sector)

  const ref = useClickAway<HTMLDivElement>(() => {
    console.log("click away")
    setPlayerTargetId(undefined)
    setLookAtTarget(undefined)
  })

  if (!sector) return null

  const player = sector.players?.find((player) => player.id === playerTargetId)

  if (!playerTargetId || !player) return null

  return (
    <div
      ref={ref}
      className="absolute w-fit h-fit bg-background elbow elbow-offset-1 elbow-1 border border-border top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-90 p-ui-sm text-xs uppercase -ml-40 flex flex-col gap-ui-sm shadow-xlong"
    >
      <span className="text-sm font-semibold">{player.name}</span>
      <ShipDetailsCallout ship_type={player.ship.ship_type} />
    </div>
  )
}
