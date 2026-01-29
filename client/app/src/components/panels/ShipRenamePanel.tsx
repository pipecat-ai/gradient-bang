import { useState } from "react"

import { CircleNotchIcon, WarningDiamondIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { validateName } from "@/utils/formatting"

import { DottedTitle } from "../DottedTitle"
import { Button } from "../primitives/Button"
import { Card, CardContent } from "../primitives/Card"
import { Input } from "../primitives/Input"

export const ShipRenamePanel = () => {
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
    <Card size="sm" className="border-0 border-b border-l">
      <CardContent className="flex flex-col gap-ui-sm">
        <DottedTitle title={`Rename ${ship?.ship_name ?? "ship"}`} />
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
  )
}
