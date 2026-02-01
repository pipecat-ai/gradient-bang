import { BlankSlateTile } from "../BlankSlates"
import { DottedTitle } from "../DottedTitle"
import { Card, CardContent } from "../primitives/Card"
import { Divider } from "../primitives/Divider"

export const ShipEquipmentPanel = () => {
  return (
    <Card size="sm" className="border-0 border-b">
      <CardContent className="flex flex-col gap-ui-sm">
        <DottedTitle title="Active Components" />
        <BlankSlateTile text="No equipment installed" />
        <Divider color="secondary" className="" />
      </CardContent>
    </Card>
  )
}
