import { Center } from "@/hud/Center"
import { LHS } from "@/hud/LHS"
import { RHS } from "@/hud/RHS"

export const ShipHUD = () => {
  return (
    <div className="flex flex-row h-ui-hud mt-auto z-(--z-hud) justify-between">
      <div className="grid grid-cols-(--grid-cols-hud) gap-ui-lg w-full items-end justify-between p-ui-sm">
        <LHS />
        <Center />
        <RHS />
      </div>
    </div>
  )
}
