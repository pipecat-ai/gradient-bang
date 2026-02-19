import { RHSPanelContent } from "@/components/panels/RHSPanelContainer"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"

export const RankPanel = () => {
  return (
    <RHSPanelContent>
      <Card>
        <CardHeader>
          <CardTitle>Your rank</CardTitle>
        </CardHeader>
        <CardContent>Hello</CardContent>
      </Card>
    </RHSPanelContent>
  )
}
