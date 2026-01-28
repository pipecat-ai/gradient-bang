import { useState } from "react"

import { CircleNotchIcon } from "@phosphor-icons/react"

import ImageAutonomousProbe from "@/assets/images/ships/autonomous_probe.png"
import ImageBulwarkDestroyer from "@/assets/images/ships/bulwark_destroyer.png"
import ImageBulwarkDestroyerLogo from "@/assets/images/ships/bulwark_destroyer_logo.png"
import ImageKestrel from "@/assets/images/ships/kestrel_courier.png"
import ImageKestrelLogo from "@/assets/images/ships/kestrel_courier_logo.png"
import { useGameContext } from "@/hooks/useGameContext"
import useGameStore from "@/stores/game"

import { Button } from "../primitives/Button"
import { Divider } from "../primitives/Divider"

const SHIP_IMAGE_MAP = {
  autonomous_probe: ImageAutonomousProbe,
  kestrel_courier: ImageKestrel,
  bulwark_destroyer: ImageBulwarkDestroyer,
}
const SHIP_LOGO_MAP = {
  kestrel_courier: ImageKestrelLogo,
  bulwark_destroyer: ImageBulwarkDestroyerLogo,
}

export const ShipDetails = ({ ship }: { ship: ShipDefinition }) => {
  const shipImage = SHIP_IMAGE_MAP[ship.ship_type as keyof typeof SHIP_IMAGE_MAP]
  const shipLogo = SHIP_LOGO_MAP[ship.ship_type as keyof typeof SHIP_LOGO_MAP]
  const setActiveScreen = useGameStore.use.setActiveScreen?.()
  const { sendUserTextInput } = useGameContext()
  const [imageLoading, setImageLoading] = useState(true)

  return (
    <div className="relative flex flex-row gap-ui-md">
      <figure className="relative size-[512px] bg-accent-background border border-terminal">
        {shipImage && imageLoading && (
          <div className="absolute inset-0 flex items-center justify-center cross-lines-accent cross-lines-offset-8">
            <CircleNotchIcon className="size-8 animate-spin z-10 text-subtle" weight="duotone" />
          </div>
        )}
        {shipImage && (
          <img
            src={shipImage}
            alt={ship.display_name}
            className={`w-full h-full object-cover transition-opacity ${imageLoading ? "opacity-0" : "opacity-100"}`}
            onLoad={() => setImageLoading(false)}
          />
        )}
        <div className="absolute bottom-ui-md inset-x-ui-md z-10">
          <div className="flex flex-row gap-4 items-center">
            <figure className="size-[64px]">
              <img src={shipLogo} alt={ship.display_name} />
            </figure>
            <Divider
              color="primary"
              variant="dotted"
              orientation="vertical"
              className="w-[12px] h-[64px] opacity-30"
            />
            <div className="flex flex-col gap-2">
              <span className="text-2xl uppercase font-semibold leading-none">
                {ship.display_name}
              </span>
              <span className="text-sm uppercase">
                {(ship.stats as unknown as { role: string }).role}
              </span>
            </div>
          </div>
        </div>
      </figure>
      <aside className="flex flex-col gap-4 w-md justify-between">
        <div>Data goes here</div>
        <footer className="flex flex-col gap-ui-sm">
          <Divider
            color="secondary"
            variant="dashed"
            orientation="horizontal"
            className="w-full h-[12px]"
          />
          <Button
            onClick={() => {
              sendUserTextInput(
                `I'd like to buy a ${ship.display_name} for ${ship.purchase_price} credits`
              )
              setActiveScreen(undefined)
            }}
          >
            Request to buy
          </Button>
        </footer>
      </aside>
    </div>
  )
}
