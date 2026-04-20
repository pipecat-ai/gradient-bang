import { useEffect, useState } from "react"

import { CopyIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react"

import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

/**
 * Read-only view of the player's corporation — name, members, ships.
 *
 * The founder gets an extra section with the invite passphrase (copy
 * button) and a Regenerate action. Non-founder members see a note
 * explaining that only the founder can view/regenerate the code.
 *
 * Reads directly from `useGameStore.use.corporation()`. The store's
 * lightweight corp summary (from `status.update`/`status.snapshot`)
 * carries `is_founder` and (for founders) `invite_code`, but not
 * `members`/`ships`. We refresh those heavy fields on mount via
 * `get-my-corporation` so the roster/fleet is current every time
 * the modal is opened.
 */
export const CorporationDetailsDialog = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const corporation = useGameStore.use.corporation?.()
  const dispatchAction = useGameStore.use.dispatchAction()
  const client = usePipecatClientStore((state) => state.client)

  const [copied, setCopied] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  // Refresh members/ships on mount. `status.*` events carry only the
  // founder-aware essentials; the heavy roster/fleet lists come from
  // `my_corporation` and are only re-fetched on explicit dispatch.
  useEffect(() => {
    dispatchAction({ type: "get-my-corporation" })
  }, [dispatchAction])

  const close = () => setActiveModal(undefined)

  const onCopy = async () => {
    if (!corporation?.invite_code) return
    try {
      await navigator.clipboard.writeText(corporation.invite_code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error("Failed to copy invite code", err)
    }
  }

  const onRegenerate = () => {
    if (!client) return
    setRegenerating(true)
    client.sendClientMessage("regenerate-invite-code", {})
    // The corporation.invite_code_regenerated event will refresh the store;
    // reset the spinner after a short window regardless.
    setTimeout(() => setRegenerating(false), 2500)
  }

  if (!corporation) {
    // Modal shouldn't be openable without a corp, but render nothing defensively.
    return null
  }

  const members = corporation.members ?? []
  const ships = corporation.ships ?? []
  const isFounder = corporation.is_founder === true

  return (
    <BaseDialog modalName="corporation_details" title={corporation.name} size="xl" onClose={close}>
      <Card
        variant="stripes"
        size="default"
        className="w-full h-fit shadow-2xl stripe-frame-primary bg-background"
      >
        <CardHeader>
          <CardTitle>{corporation.name}</CardTitle>
          <div className="text-xs text-muted-foreground uppercase">
            {members.length} {members.length === 1 ? "member" : "members"}
            {ships.length > 0 ? ` · ${ships.length} ${ships.length === 1 ? "ship" : "ships"}` : ""}
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-6 text-sm">
          {isFounder && corporation.invite_code && (
            <>
              <section className="flex flex-col gap-2">
                <div className="text-xs uppercase text-muted-foreground">
                  Invite passphrase (founder only — share verbally or copy)
                </div>
                <div className="flex flex-row items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-accent-background font-mono text-base tracking-wide">
                    {corporation.invite_code}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onCopy}
                    aria-label="Copy invite code"
                  >
                    <CopyIcon size={16} />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRegenerate}
                    disabled={regenerating}
                    aria-label="Regenerate invite code"
                  >
                    <ArrowsClockwiseIcon size={16} />
                    {regenerating ? "Regenerating…" : "Regenerate"}
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">
                  Regenerating invalidates the current code. Anyone with the old code will no longer
                  be able to join.
                </div>
              </section>
              <Divider decoration="plus" color="accent" />
            </>
          )}

          {!isFounder && (
            <>
              <section className="flex flex-col gap-1">
                <div className="text-xs uppercase text-muted-foreground">Invite passphrase</div>
                <p className="text-muted-foreground">
                  Only the corporation founder can view or regenerate the invite code.
                </p>
              </section>
              <Divider decoration="plus" color="accent" />
            </>
          )}

          <section className="flex flex-col gap-2">
            <div className="text-xs uppercase text-muted-foreground">Members</div>
            {members.length === 0 ?
              <p className="text-muted-foreground">No members.</p>
            : <ul className="flex flex-col gap-1">
                {members.map((m) => (
                  <li key={m.character_id} className="flex flex-row gap-2 items-center">
                    <span>{m.name}</span>
                    {m.character_id === corporation.founder_id && (
                      <span className="text-xs uppercase text-terminal">Founder</span>
                    )}
                  </li>
                ))}
              </ul>
            }
          </section>

          <Divider decoration="plus" color="accent" />

          <section className="flex flex-col gap-2">
            <div className="text-xs uppercase text-muted-foreground">Fleet</div>
            <p>
              {ships.length === 0 ?
                "No corporation ships."
              : `${ships.length} ${ships.length === 1 ? "ship" : "ships"}`}
            </p>
          </section>
        </CardContent>
      </Card>
    </BaseDialog>
  )
}
