import {
  ChargingStationIcon,
  LetterCirclePIcon,
  RankingIcon,
  ShippingContainerIcon,
} from "@phosphor-icons/react"

import { BlankSlateTile } from "@/components/BlankSlates"
import { RHSPanelContent, RHSSubPanel } from "@/components/panels/RHSPanelContainer"
import { RHSPanelDivider, RHSPanelList, RHSPanelListItem } from "@/components/panels/RHSPanelList"
import { ShipCatalogue } from "@/components/panels/ShipCatalogue"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"

export const TradePanel = () => {
  const sector = useGameStore((state) => state.sector)
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()

  const port = sector?.port

  return (
    <RHSPanelContent>
      <Card size="sm" className="border-0 border-b">
        <CardHeader>
          <CardTitle>Port Info</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-sm pr-0">
          {!port ?
            <BlankSlateTile text="This sector does not have a port" />
          : <>
              <RHSPanelList>
                <RHSPanelListItem label="Code" value={port?.code} Icon={LetterCirclePIcon} />
                <RHSPanelListItem label="Class" value={port?.port_class} Icon={RankingIcon} />
                <RHSPanelListItem
                  label="Refuel Station"
                  disabled={!port?.mega}
                  value={port?.mega ? "Yes" : "No"}
                  Icon={ChargingStationIcon}
                  valueClassName="text-terminal"
                />
                <RHSPanelListItem
                  disabled={!port?.mega}
                  label="Shipyard"
                  value={port?.mega ? "Yes" : "No"}
                  Icon={ShippingContainerIcon}
                  onClick={() => setActiveSubPanel("ship-catalog")}
                />
              </RHSPanelList>
              <RHSPanelDivider />
            </>
          }
        </CardContent>
      </Card>

      <RHSSubPanel>
        <ShipCatalogue />
      </RHSSubPanel>
    </RHSPanelContent>
  )
}
