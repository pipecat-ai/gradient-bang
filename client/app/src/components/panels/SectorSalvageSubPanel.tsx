import { useGameContext } from "@/hooks/useGameContext"
import { SalvageIcon } from "@/icons"

import { BlankSlateTile } from "../BlankSlates"
import { DottedTitle } from "../DottedTitle"
import { Button } from "../primitives/Button"
import { DotDivider } from "../primitives/DotDivider"

import { RESOURCE_SHORT_NAMES } from "@/types/constants"

const LootSummary = ({
  cargo,
  credits,
  scrap,
}: {
  cargo?: Record<Resource, number>
  credits?: number
  scrap?: number
}) => {
  const cargoEntries =
    cargo ? (Object.entries(cargo) as [Resource, number][]).filter(([, v]) => v > 0) : []
  const hasCredits = credits != null && credits > 0
  const hasScrap = scrap != null && scrap > 0
  const hasAnything = cargoEntries.length > 0 || hasCredits || hasScrap

  if (!hasAnything) return <span className="text-subtle">Nothing</span>

  const items: React.ReactNode[] = []

  if (hasCredits) {
    items.push(
      <span key="credits" className="inline-flex items-center gap-0.5">
        <span className="text-accent-foreground font-bold">{credits}</span> credits
      </span>
    )
  }

  if (hasScrap) {
    items.push(
      <span key="scrap" className="inline-flex items-center gap-0.5">
        <span className="text-accent-foreground font-bold">{scrap}</span> scrap
      </span>
    )
  }

  cargoEntries.forEach(([resource, amount]) => {
    items.push(
      <span key={resource} className="inline-flex items-center gap-0.5">
        <span className="text-accent-foreground font-bold">{amount}</span>
        <span>{RESOURCE_SHORT_NAMES[resource]}</span>
      </span>
    )
  })

  return (
    <span className="flex gap-1.5 items-center flex-wrap">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {item}
          {i < items.length - 1 && <DotDivider className="ml-1" />}
        </span>
      ))}
    </span>
  )
}

const SalvageCard = ({ salvage }: { salvage: Salvage }) => {
  const { sendUserTextInput } = useGameContext()

  const cargo = salvage.remaining?.cargo ?? salvage.cargo
  const credits = salvage.remaining?.credits ?? salvage.credits
  const scrap = salvage.remaining?.scrap ?? salvage.scrap

  return (
    <li className="group py-ui-xs bg-subtle-background even:bg-subtle-background/50 flex flex-row items-center">
      <div className="flex flex-row gap-ui-sm items-center px-ui-xs w-full">
        <div className="bg-accent-background p-ui-xs flex items-center justify-center border border-accent shrink-0">
          <SalvageIcon size={16} weight="duotone" className="text-subtle" />
        </div>
        <div className="w-0 grow flex flex-row gap-ui-sm items-center">
          <div className="w-0 grow overflow-hidden flex flex-col gap-0.5 border-l border-accent px-ui-xs uppercase">
            <h3 className="text-sm font-bold truncate">
              {salvage.source?.ship_name ?? "Unknown wreck"}
            </h3>
            {salvage.source?.ship_type && (
              <span className="flex gap-1.5 items-center text-xxs text-subtle-foreground min-w-0">
                <span className="truncate shrink">{salvage.source.ship_type}</span>
              </span>
            )}
            <span className="flex gap-1.5 items-center text-xxs text-subtle-foreground min-w-0">
              <LootSummary cargo={cargo} credits={credits} scrap={scrap} />
            </span>
          </div>
          <div className="opacity-0 group-hover:opacity-100 shrink-0">
            <Button
              variant="ui"
              size="sm"
              onClick={() => {
                sendUserTextInput(`collect salvage id ${salvage.salvage_id} in sector`)
              }}
            >
              Collect
            </Button>
          </div>
        </div>
      </div>
    </li>
  )
}

export const SectorSalvageSubPanel = ({ sector }: { sector?: Sector }) => {
  const salvage = sector?.salvage?.filter((s) => !s.fully_collected)

  return (
    <aside className="flex flex-col gap-ui-sm">
      <DottedTitle title="Salvage in sector" />
      {salvage && salvage.length > 0 ?
        <ul className="list-none p-0 m-0">
          {salvage.map((s) => (
            <SalvageCard key={s.salvage_id} salvage={s} />
          ))}
        </ul>
      : <BlankSlateTile text="No salvage in sector" />}
    </aside>
  )
}
