import { Card, CardHeader, CardTitle } from "@/components/primitives/Card"
import { SettingsPanel } from "@/components/SettingsPanel"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

export const Settings = () => {
  const setActiveModal = useGameStore.use.setActiveModal()

  const handleClose = () => {
    setActiveModal(undefined)
  }

  return (
    <BaseDialog modalName="settings" title="Settings" size="lg">
      <Card
        elbow={true}
        size="default"
        className="w-full h-full max-h-max bg-black shadow-2xl"
      >
        <CardHeader>
          <CardTitle className="heading-2">Settings</CardTitle>
        </CardHeader>
        <SettingsPanel onSave={handleClose} onCancel={handleClose} />
      </Card>
    </BaseDialog>
  )
}
