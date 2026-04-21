import { useMemo, useState } from "react"

import { ArrowsClockwiseIcon } from "@phosphor-icons/react"
import { type ColumnDef } from "@tanstack/react-table"

import { DataTableScrollArea } from "@/components/DataTable"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import useGameStore from "@/stores/game"

import { BaseDialog } from "./BaseDialog"

type MemberRow = {
  character_id: string
  name: string
  is_founder: boolean
}

const memberColumns: ColumnDef<MemberRow>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => row.original.name,
  },
  {
    accessorKey: "is_founder",
    header: "Role",
    meta: { align: "right", width: "80px" },
    cell: ({ row }) =>
      row.original.is_founder ?
        <span className="text-terminal uppercase">Founder</span>
      : <span className="text-muted-foreground">Member</span>,
  },
]

export const CorporationDetailsDialog = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const activeModal = useGameStore.use.activeModal?.()
  const corporation = useGameStore.use.corporation?.()
  const dispatchAction = useGameStore.use.dispatchAction()

  // Track the code that was active when Regenerate was clicked. Once
  // the store updates with a different code, regenerating becomes false.
  // Gate on isOpen so stale state from a previous open is never visible.
  const [regeneratingFromCode, setRegeneratingFromCode] = useState<string | null>(null)

  const isOpen = activeModal?.modal === "corporation_details"
  const regenerating =
    isOpen && regeneratingFromCode !== null && regeneratingFromCode === corporation?.invite_code

  const close = () => setActiveModal(undefined)

  const onRegenerate = () => {
    setRegeneratingFromCode(corporation?.invite_code ?? null)
    dispatchAction({ type: "regenerate-invite-code" })
  }

  const memberRows: MemberRow[] = useMemo(
    () =>
      (corporation?.members ?? []).map((m) => ({
        character_id: m.character_id,
        name: m.name,
        is_founder: m.character_id === corporation?.founder_id,
      })),
    [corporation?.members, corporation?.founder_id]
  )

  if (!corporation) {
    return (
      <BaseDialog modalName="corporation_details" title="Corporation" size="lg" onClose={close}>
        <Card elbow={true} size="default" className="w-full h-full bg-black shadow-2xl">
          <CardContent className="flex items-center justify-center py-12">
            <p className="text-muted-foreground text-sm uppercase">Not in a corporation</p>
          </CardContent>
        </Card>
      </BaseDialog>
    )
  }

  const ships = corporation.ships ?? []
  const isFounder = corporation.is_founder === true

  return (
    <BaseDialog modalName="corporation_details" title={corporation.name} size="lg" onClose={close}>
      <Card elbow={true} size="default" className="w-full h-full bg-black shadow-2xl">
        <CardHeader>
          <CardTitle className="heading-2">{corporation.name}</CardTitle>
          <div className="text-xs text-muted-foreground uppercase">
            {memberRows.length} {memberRows.length === 1 ? "member" : "members"}
            {ships.length > 0 ? ` · ${ships.length} ${ships.length === 1 ? "ship" : "ships"}` : ""}
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-6 text-sm h-full min-h-0">
          {isFounder && corporation.invite_code && (
            <>
              <section className="corner-dots border border-accent bg-subtle-background p-3 flex flex-col gap-2">
                <div className="text-xs uppercase text-muted-foreground">
                  Invite passphrase (founder only)
                </div>
                <div className="flex flex-row items-center gap-2">
                  <code className="flex-1 font-mono text-base tracking-wide">
                    {corporation.invite_code}
                  </code>
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

          <section className="flex flex-col gap-2 flex-1 min-h-0">
            <div className="text-xs uppercase text-muted-foreground">Members</div>
            {memberRows.length === 0 ?
              <p className="text-muted-foreground">No members.</p>
            : <DataTableScrollArea<MemberRow>
                data={memberRows}
                columns={memberColumns}
                striped
                className="h-full"
              />
            }
          </section>

          <Divider decoration="plus" color="accent" />

          <section className="flex flex-col gap-2">
            <div className="text-xs uppercase text-muted-foreground">Fleet</div>
            <p className="text-muted-foreground">
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
