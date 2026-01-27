import { NeuroSymbolicsIcon, QuantumFoamIcon, RetroOrganicsIcon } from "@/icons"
import { cn } from "@/utils/tailwind"

import { Badge } from "./primitives/Badge"

import { RESOURCE_VERBOSE_NAMES } from "@/types/constants"

const ICON_MAP = {
  quantum_foam: <QuantumFoamIcon size={20} weight="duotone" />,
  retro_organics: <RetroOrganicsIcon size={20} weight="duotone" />,
  neuro_symbolics: <NeuroSymbolicsIcon size={20} weight="duotone" />,
}
export const ResourceTitle = ({
  resource,
  className,
  value,
}: {
  resource: Resource
  className?: string
  value?: number
}) => {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 text-xs font-bold items-center justify-center border p-ui-xs bg-subtle-background",
        className
      )}
    >
      <span className="text-xxs uppercase text-foreground font-medium truncate">
        {RESOURCE_VERBOSE_NAMES[resource]}
      </span>
      {ICON_MAP[resource]}
      <Badge
        size="sm"
        variant="secondary"
        border="bracket"
        className="flex-1 w-full flex flex-col gap-2 bg-background py-0.5 "
      >
        <span className={cn("text-xs", value === undefined || value === 0 ? "text-subtle" : "")}>
          {value ?? "---"}
        </span>
      </Badge>
    </div>
  )
}
