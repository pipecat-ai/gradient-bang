import useGameStore from "@/stores/game"

import { BlankSlateTile } from "../BlankSlates"
import { DottedTitle } from "../DottedTitle"
import { Button } from "../primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { RHSPanelContent, RHSSubPanel } from "./RHSPanelContainer"
import { ShipCatalogue } from "./ShipCatalogue"

export const PlayerPanel = () => {
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()

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

      <RHSSubPanel>
        <ShipCatalogue />
      </RHSSubPanel>
    </RHSPanelContent>
  )
}
