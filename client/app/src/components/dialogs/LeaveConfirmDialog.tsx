import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

/**
 * Destructive confirmation when the player leaves their corporation.
 *
 * Opened by GameContext when `corporation.leave_pending` fires. Handles
 * both explicit leave and leave-to-join flows (distinguished by the
 * presence of `joining_corp_id` in the data payload).
 *
 * Clicking Confirm sends `confirm-leave` back to the bot, which calls
 * either `leave_corporation(confirm=true)` or
 * `join_corporation(confirm=true)` depending on whether join context is
 * present. The edge function re-validates everything before mutating.
 */
export const LeaveConfirmDialog = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const client = usePipecatClientStore((state) => state.client)

  const data =
    activeModal?.modal === "confirm_leave" ?
      (activeModal.data as ConfirmLeaveData | undefined)
    : undefined

  const corpName = data?.corp_name ?? "your corporation"
  const willDisband = data?.will_disband ?? false
  const isFounder = data?.is_founder ?? false
  const memberCount = data?.member_count ?? 0
  const joiningCorpName = data?.joining_corp_name
  const isJoining = Boolean(data?.joining_corp_id)

  let title: string
  let body: React.ReactNode
  let confirmLabel: string

  if (isJoining && willDisband) {
    // Leaving to join another corp, old corp will be disbanded.
    title = `Disband ${corpName}?`
    body = (
      <>
        <p>
          Leaving <strong>{corpName}</strong> to join <strong>{joiningCorpName}</strong> will{" "}
          <strong>permanently disband</strong> {corpName}
          {isFounder && memberCount > 1 ?
            ` and remove all ${memberCount - 1} other member${memberCount - 1 > 1 ? "s" : ""}`
          : ""}
          .
        </p>
        <p className="text-destructive-foreground/80">This cannot be undone.</p>
      </>
    )
    confirmLabel = `Join ${joiningCorpName}`
  } else if (isJoining) {
    // Leaving to join, old corp continues (non-founder, not last member).
    title = `Leave ${corpName}?`
    body = (
      <p>
        You will leave <strong>{corpName}</strong> and join <strong>{joiningCorpName}</strong>. You
        will need a new invite passphrase to rejoin {corpName}.
      </p>
    )
    confirmLabel = `Join ${joiningCorpName}`
  } else if (isFounder && memberCount > 1) {
    // Founder leaving explicitly, other members exist.
    title = `Disband ${corpName}?`
    body = (
      <>
        <p>
          As the founder, leaving will <strong>permanently disband</strong> {corpName} and remove
          all {memberCount - 1} other member
          {memberCount - 1 > 1 ? "s" : ""}.
        </p>
        <p className="text-destructive-foreground/80">This cannot be undone.</p>
      </>
    )
    confirmLabel = "Disband & Leave"
  } else if (willDisband) {
    // Last member leaving.
    title = `Disband ${corpName}?`
    body = (
      <>
        <p>
          You are the last member. Leaving will <strong>permanently disband</strong> {corpName}.
        </p>
        <p className="text-destructive-foreground/80">This cannot be undone.</p>
      </>
    )
    confirmLabel = "Disband & Leave"
  } else {
    // Non-founder leaving, corp continues.
    title = `Leave ${corpName}?`
    body = (
      <p>
        You will lose corporation access immediately. You will need a new invite passphrase to
        rejoin.
      </p>
    )
    confirmLabel = "Leave"
  }

  const onConfirm = () => {
    if (!client || !data) {
      setActiveModal(undefined)
      return
    }
    const payload: Record<string, string> = {}
    if (data.joining_corp_id) {
      payload.joining_corp_id = data.joining_corp_id
      payload.joining_invite_code = data.joining_invite_code ?? ""
    }
    client.sendClientMessage("confirm-leave", payload)
    setActiveModal(undefined)
  }

  const onCancel = () => {
    setActiveModal(undefined)
    client?.sendClientMessage("cancel-leave", {})
  }

  return (
    <BaseDialog
      modalName="confirm_leave"
      title="Leave corporation"
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
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="h-full min-h-0 text-sm space-y-3">{body}</CardContent>
        <CardFooter className="flex flex-col gap-6">
          <Divider decoration="plus" color="accent" />
          <div className="flex flex-row gap-3 w-full">
            <Button variant="outline" onClick={onCancel} className="flex-1">
              Stay
            </Button>
            <Button onClick={onConfirm} className="flex-1">
              {confirmLabel}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </BaseDialog>
  )
}
