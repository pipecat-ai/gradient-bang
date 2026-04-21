import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

/**
 * Destructive confirmation for kicking a corporation member.
 *
 * Opened by GameContext when `corporation.kick_pending` fires (emitted
 * character-scoped to the kicker only). Clicking Confirm sends
 * `confirm-kick` to the bot, which calls the edge function with
 * `confirm: true` and injects an LLM context event so the voice agent
 * narrates the outcome. Cancel just closes and tells the LLM nothing
 * happened.
 */
export const KickConfirmDialog = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const client = usePipecatClientStore((state) => state.client)

  const data =
    activeModal?.modal === "confirm_kick" ?
      (activeModal.data as ConfirmKickData | undefined)
    : undefined

  const targetName = data?.target_name ?? "this member"
  const corpName = data?.corp_name ?? "your corporation"

  const onConfirm = () => {
    if (!client || !data) {
      setActiveModal(undefined)
      return
    }
    client.sendClientMessage("confirm-kick", {
      target_id: data.target_id,
      target_name: data.target_name,
    })
    setActiveModal(undefined)
  }

  const onCancel = () => {
    setActiveModal(undefined)
    client?.sendClientMessage("cancel-kick", {
      target_name: data?.target_name,
    })
  }

  return (
    <BaseDialog
      modalName="confirm_kick"
      title="Remove member"
      size="lg"
      dismissOnClickOutside={false}
      showCloseButton={false}
      showOverlay={false}
      onClose={onCancel}
    >
      <Card
        variant="stripes"
        size="default"
        className="w-full h-fit shadow-2xl stripe-frame-destructive bg-background"
      >
        <CardHeader>
          <CardTitle>Remove {targetName}?</CardTitle>
        </CardHeader>
        <CardContent className="h-full min-h-0 text-sm">
          This will remove <strong>{targetName}</strong> from {corpName}. They will lose corporation
          access immediately and will need a new invite passphrase to rejoin.
        </CardContent>
        <CardFooter className="flex flex-col gap-6">
          <Divider decoration="plus" color="accent" />
          <div className="flex flex-row gap-3 w-full">
            <Button variant="outline" onClick={onCancel} className="flex-1">
              Cancel
            </Button>
            <Button onClick={onConfirm} className="flex-1">
              Remove {targetName}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </BaseDialog>
  )
}
