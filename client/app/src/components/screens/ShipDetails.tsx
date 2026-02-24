import { useState } from "react"

import { CircleNotchIcon, ShieldIcon } from "@phosphor-icons/react"

import ImageAegisCruiser from "@/assets/images/ships/aegis_cruiser.png"
import ImageAtlasHauler from "@/assets/images/ships/atlas_hauler.png"
import ImageAutonomousLightHauler from "@/assets/images/ships/autonomous_light_hauler.png"
import ImageAutonomousProbe from "@/assets/images/ships/autonomous_probe.png"
import ImageBulwarkDestroyer from "@/assets/images/ships/bulwark_destroyer.png"
import ImageCorsairRaider from "@/assets/images/ships/corsair_raider.png"
import ImageKestrel from "@/assets/images/ships/kestrel_courier.png"
import ImagePikeFrigate from "@/assets/images/ships/pike_frigate.png"
import ImagePioneerLifter from "@/assets/images/ships/pioneer_lifter.png"
import ImageSovereignStarcruiser from "@/assets/images/ships/sovereign_starcruiser.png"
import ImageSparrowScout from "@/assets/images/ships/sparrow_scout.png"
import ImageWayfarerFreighter from "@/assets/images/ships/wayfarer_freighter.png"
import { DottedTitle } from "@/components/DottedTitle"
import { Badge } from "@/components/primitives/Badge"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/primitives/Select"
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
import { shipTypeVerbose } from "@/utils/game"
import { getShipLogoImage } from "@/utils/images"
import { getPortCode } from "@/utils/port"

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
  const shipLogo = getShipLogoImage(ship.ship_type)
  const sector = useGameStore.use.sector?.()
  const setActiveScreen = useGameStore.use.setActiveScreen?.()
  const { sendUserTextInput } = useGameContext()
  const [imageLoading, setImageLoading] = useState(true)

  const playerShip = useGameStore((state) => state.ship)
  const shipsState = useGameStore.use.ships()
  const allShips = shipsState.data ?? []
  const personalShips = allShips.filter((s) => s.owner_type === "personal")
  const corpShips = allShips.filter((s) => s.owner_type === "corporation")

  const defaultShipId = playerShip?.ship_id ?? ""
  const [selectedShipId, setSelectedShipId] = useState(defaultShipId)

  const selectedShip = [playerShip, ...allShips].find((s) => s?.ship_id === selectedShipId)

  const isMegaPort = getPortCode(sector?.port ?? null) === "SSS"

  return (
    <div className="relative flex flex-col gap-ui-md">
      <div className="flex flex-row gap-ui-md">
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
                value={ship.shields}
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
          </div>
          <div>
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
        </aside>
      </div>
      <Divider
        color="secondary"
        variant="dashed"
        orientation="horizontal"
        className="w-full h-[12px]"
      />
      <Card className="bracket bracket-offset-1 flex flex-col gap-ui-md">
        <CardContent>
          <DottedTitle title={"Purchase " + ship.display_name} textColor="text-terminal" />
        </CardContent>
        <CardContent className="flex flex-row flex-1 gap-ui-md">
          <Select value={selectedShipId} onValueChange={setSelectedShipId}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select ship to trade-in" />
            </SelectTrigger>
            <SelectContent>
              {personalShips.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Your Ships</SelectLabel>
                  {personalShips.map((s) => (
                    <SelectItem key={s.ship_id} value={s.ship_id}>
                      {s.ship_name} ({shipTypeVerbose(s.ship_type)})
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {personalShips.length > 0 && corpShips.length > 0 && <SelectSeparator />}
              {corpShips.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Corporation Ships</SelectLabel>
                  {corpShips.map((s) => (
                    <SelectItem key={s.ship_id} value={s.ship_id}>
                      {s.ship_name} ({shipTypeVerbose(s.ship_type)})
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          <Button
            onClick={() => {
              const replaceName = selectedShip?.ship_name ?? "my ship"
              const replaceId = selectedShip?.ship_id ?? ""
              sendUserTextInput(
                `I'd like to purchase a ${ship.display_name} to replace ${replaceName} (ship ID: ${replaceId})`
              )
              setActiveScreen(undefined)
            }}
            disabled={!isMegaPort || !selectedShipId}
            className={`min-w-64 ${
              !isMegaPort ?
                "relative after:content-[''] after:absolute after:inset-0 after:bg-stripes-sm after:bg-stripes-border"
              : ""
            }`}
          >
            <span className={isMegaPort ? "" : "relative z-10 text-foreground"}>
              {isMegaPort ? "Request to buy" : "Must be at Mega-Port"}
            </span>
          </Button>
        </CardContent>
      </Card>
      <Button
        variant="secondary"
        className="bg-accent-background/50 text-foreground hover:bg-accent-background w-full"
        onClick={() => setActiveScreen(undefined)}
      >
        Close
      </Button>
    </div>
  )
}
