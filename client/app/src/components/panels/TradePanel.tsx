import { Card, CardHeader, CardTitle } from "../primitives/Card"
import { RHSPanelContent } from "./RHSPanelContainer"

export const TradePanel = () => {
  return (
    <RHSPanelContent>
      <Card size="sm" className="border-0 border-b">
        <CardHeader>
          <CardTitle>Trade</CardTitle>
        </CardHeader>
      </Card>
    </RHSPanelContent>
  )
}
