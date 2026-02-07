import { useState } from "react"

import { CircleNotchIcon, ShieldIcon } from "@phosphor-icons/react"

import ImageAegisCruiser from "@/assets/images/ships/aegis_cruiser.png"
import ImageAegisCruiserLogo from "@/assets/images/ships/aegis_cruiser_logo.png"
import ImageAtlasHauler from "@/assets/images/ships/atlas_hauler.png"
import ImageAtlasHaulerLogo from "@/assets/images/ships/atlas_hauler_logo.png"
import ImageAutonomousLightHauler from "@/assets/images/ships/autonomous_light_hauler.png"
import ImageAutonomousLightHaulerLogo from "@/assets/images/ships/autonomous_light_hauler_logo.png"
import ImageAutonomousProbe from "@/assets/images/ships/autonomous_probe.png"
import ImageAutonomousProbeLogo from "@/assets/images/ships/autonomous_probe_logo.png"
import ImageBulwarkDestroyer from "@/assets/images/ships/bulwark_destroyer.png"
import ImageBulwarkDestroyerLogo from "@/assets/images/ships/bulwark_destroyer_logo.png"
import ImageCorsairRaider from "@/assets/images/ships/corsair_raider.png"
import ImageCorsairRaiderLogo from "@/assets/images/ships/corsair_raider_logo.png"
import ImageKestrel from "@/assets/images/ships/kestrel_courier.png"
import ImageKestrelLogo from "@/assets/images/ships/kestrel_courier_logo.png"
import ImagePikeFrigate from "@/assets/images/ships/pike_frigate.png"
import ImagePikeFrigateLogo from "@/assets/images/ships/pike_frigate_logo.png"
import ImagePioneerLifter from "@/assets/images/ships/pioneer_lifter.png"
import ImagePioneerLifterLogo from "@/assets/images/ships/pioneer_lifter_logo.png"
import ImageSovereignStarcruiser from "@/assets/images/ships/sovereign_starcruiser.png"
import ImageSovereignStarcruiserLogo from "@/assets/images/ships/sovereign_starcruiser_logo.png"
import ImageSparrowScout from "@/assets/images/ships/sparrow_scout.png"
import ImageSparrowScoutLogo from "@/assets/images/ships/sparrow_scout_logo.png"
import ImageWayfarerFreighter from "@/assets/images/ships/wayfarer_freighter.png"
import ImageWayfarerFreighterLogo from "@/assets/images/ships/wayfarer_freighter_logo.png"
import { useGameContext } from "@/hooks/useGameContext"
import {
  CargoIcon,
  CreditsIcon,
  EquipmentSlotsIcon,
  FighterIcon,
  FuelIcon,
  TurnsPerWarpIcon,
} from "@/icons"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"
import { getPortCode } from "@/utils/port"

import { DottedTitle } from "../DottedTitle"
import { Badge } from "../primitives/Badge"
import { Button } from "../primitives/Button"
import { Divider } from "../primitives/Divider"

const SHIP_IMAGE_MAP = {
  autonomous_probe: ImageAutonomousProbe,
  autonomous_light_hauler: ImageAutonomousLightHauler,
  pioneer_lifter: ImagePioneerLifter,
  sovereign_starcruiser: ImageSovereignStarcruiser,
  atlas_hauler: ImageAtlasHauler,
  kestrel_courier: ImageKestrel,
  bulwark_destroyer: ImageBulwarkDestroyer,
  wayfarer_freighter: ImageWayfarerFreighter,
  corsair_raider: ImageCorsairRaider,
  sparrow_scout: ImageSparrowScout,
  aegis_cruiser: ImageAegisCruiser,
  pike_frigate: ImagePikeFrigate,
}
const SHIP_LOGO_MAP = {
  corsair_raider: ImageCorsairRaiderLogo,
  pioneer_lifter: ImagePioneerLifterLogo,
  sovereign_starcruiser: ImageSovereignStarcruiserLogo,
  kestrel_courier: ImageKestrelLogo,
  atlas_hauler: ImageAtlasHaulerLogo,
  bulwark_destroyer: ImageBulwarkDestroyerLogo,
  sparrow_scout: ImageSparrowScoutLogo,
  autonomous_probe: ImageAutonomousProbeLogo,
  autonomous_light_hauler: ImageAutonomousLightHaulerLogo,
  wayfarer_freighter: ImageWayfarerFreighterLogo,
  aegis_cruiser: ImageAegisCruiserLogo,
  pike_frigate: ImagePikeFrigateLogo,
}

type ShipDetailsItemProps = {
  label: string
  icon: React.ReactNode
  value: React.ReactNode
  showBorder?: boolean
}

const ShipDetailsItem = ({ label, icon, value, showBorder = true }: ShipDetailsItemProps) => (
  <li
    className={`flex flex-row gap-2 items-center ${showBorder ? "border-b border-accent pb-ui-xs" : ""}`}
  >
    <div className="flex-1 text-sm uppercase">{label}</div>
    <Badge size="sm" className="flex flex-row gap-2 items-center justify-between w-32 text-center">
      {icon}
      <span className="flex-1 text-terminal-foreground">{value}</span>
    </Badge>
  </li>
)

export const ShipDetails = ({ ship }: { ship: ShipDefinition }) => {
  const shipImage = SHIP_IMAGE_MAP[ship.ship_type as keyof typeof SHIP_IMAGE_MAP]
  const shipLogo = SHIP_LOGO_MAP[ship.ship_type as keyof typeof SHIP_LOGO_MAP]
  const sector = useGameStore.use.sector?.()
  const setActiveScreen = useGameStore.use.setActiveScreen?.()
  const { sendUserTextInput } = useGameContext()
  const [imageLoading, setImageLoading] = useState(true)

  const isMegaPort = getPortCode(sector?.port ?? null) === "SSS"

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
      <aside className="flex flex-col gap-ui-sm w-md justify-between">
        <div>
          <DottedTitle title="Ship Stats" className="py-ui-sm" />
          <ul className="flex flex-col gap-ui-xs list-none">
            <ShipDetailsItem
              label="Warp Fuel Capacity"
              icon={<FuelIcon weight="duotone" className="size-5" />}
              value={ship.warp_power_capacity}
            />
            <ShipDetailsItem
              label="Cargo Holds"
              icon={<CargoIcon weight="duotone" className="size-5" />}
              value={ship.cargo_holds}
            />
            <ShipDetailsItem
              label="Shields"
              icon={<ShieldIcon weight="duotone" className="size-5" />}
              value={ship.cargo_holds}
            />
            <ShipDetailsItem
              label="Fighters"
              icon={<FighterIcon weight="duotone" className="size-5" />}
              value={ship.fighters}
            />
            <ShipDetailsItem
              label="Turns per warp"
              icon={<TurnsPerWarpIcon weight="duotone" className="size-5" />}
              value={ship.turns_per_warp}
            />
            <ShipDetailsItem
              label="Equipment Slots"
              icon={<EquipmentSlotsIcon weight="duotone" className="size-5" />}
              value={(ship.stats as unknown as { equipment_slots: number }).equipment_slots}
              showBorder={false}
            />
          </ul>
          <DottedTitle title="Purchase Price" className="py-ui-sm" />
          <Badge
            variant="secondary"
            border="bracket"
            className="flex-1 bracket-offset-1 flex flex-row gap-2 items-center justify-between flex-1text-center"
          >
            <CreditsIcon weight="duotone" className="size-5" />
            <span className=" text-terminal-foreground">
              {formatCurrency(ship.purchase_price, "standard")}
            </span>
          </Badge>
        </div>
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
            disabled={!isMegaPort}
            className={
              !isMegaPort ?
                "relative after:content-[''] after:absolute after:inset-0 after:bg-stripes-sm after:bg-stripes-border"
              : ""
            }
          >
            <span className={isMegaPort ? "" : "relative z-10 text-foreground"}>
              {isMegaPort ? "Request to buy" : "Available at Mega-Port"}
            </span>
          </Button>
          <Button
            variant="secondary"
            className="bg-accent-background/50 text-foreground hover:bg-accent-background"
            onClick={() => setActiveScreen(undefined)}
          >
            Close
          </Button>
        </footer>
      </aside>
    </div>
  )
}
