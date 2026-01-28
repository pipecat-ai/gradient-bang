import { useState } from "react"

import { CircleNotchIcon, WarningDiamondIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { validateName } from "@/utils/formatting"

import { BlankSlateTile } from "../BlankSlates"
import { DottedTitle } from "../DottedTitle"
import { Button } from "../primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { Input } from "../primitives/Input"
import { RHSPanelContent, RHSSubPanel } from "./RHSPanelContainer"
import { ShipCatalogue } from "./ShipCatalogue"

export const PlayerPanel = () => {
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()
  const ship = useGameStore((state) => state.ship)
  const dispatchAction = useGameStore.use.dispatchAction()
  const [isLoading, setIsLoading] = useState(false)

  const [shipName, setShipName] = useState("")
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = () => {
    setError(null)

    setIsLoading(true)
    if (!validateName(shipName)) {
      setError("Name must be 3-20 characters (letters, numbers, spaces, underscores)")
      return
    }

    dispatchAction({
      type: "rename-ship",
      payload: { ship_id: ship?.ship_id, ship_name: shipName },
    })
    setIsLoading(false)
  }

  return (
    <RHSPanelContent>
      <Card size="sm" className="border-0 border-b">
        <CardHeader>
          <CardTitle>Ships</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-sm">
          <DottedTitle title="Stowed Ships" />
          <BlankSlateTile text="No stowed ships" />
          <Divider color="secondary" className="" />
          <Button variant="default" size="sm" onClick={() => setActiveSubPanel("ship-catalog")}>
            Show ship catalog
          </Button>
        </CardContent>
      </Card>
      <Card size="sm" className="border-0">
        <CardHeader>
          <CardTitle>Rename {ship?.ship_name ?? "ship"}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-sm">
          {error && (
            <Card
              variant="stripes"
              size="xs"
              className="bg-destructive/10 stripe-frame-2 stripe-frame-destructive animate-in motion-safe:fade-in-0 motion-safe:duration-1000"
            >
              <CardContent className="flex flex-col gap-2">
                <WarningDiamondIcon className="size-6 text-destructive" weight="duotone" />
                <span className="text-xs uppercase font-medium">{error}</span>
              </CardContent>
            </Card>
          )}
          <Input
            placeholder="Enter new name"
            value={shipName}
            size="sm"
            disabled={isLoading}
            onChange={(e) => setShipName(e.target.value)}
          />
          <Button
            variant="default"
            size="sm"
            onClick={handleSubmit}
            isLoading={isLoading}
            disabled={isLoading}
          >
            {isLoading ?
              <CircleNotchIcon className="size-4 animate-spin" />
            : "Rename"}
          </Button>
        </CardContent>
      </Card>

      <RHSSubPanel>
        <ShipCatalogue />
      </RHSSubPanel>
    </RHSPanelContent>
  )
}
