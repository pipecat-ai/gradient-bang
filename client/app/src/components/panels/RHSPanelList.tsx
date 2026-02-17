import type { ReactNode } from "react"
import type { Icon } from "@phosphor-icons/react"
import { ArrowRightIcon } from "@phosphor-icons/react"

import { cn } from "@/utils/tailwind"

import { Button } from "../primitives/Button"
import { Divider } from "../primitives/Divider"

interface RHSPanelListProps {
  children: ReactNode
  className?: string
}

export const RHSPanelList = ({ children, className }: RHSPanelListProps) => (
  <div className={cn("text-xs uppercase flex flex-col gap-ui-xxs flex-1 shrink-0", className)}>
    {children}
  </div>
)

export const RHSPanelDivider = ({ className }: { className?: string }) => (
  <Divider variant="dotted" className={cn("h-1.5 mb-ui-sm text-accent-background", className)} />
)

interface RHSPanelListItemProps {
  label: string
  value?: ReactNode
  empty?: string
  Icon: Icon
  count?: number
  valueClassName?: string
  onClick?: () => void
  disabled?: boolean
}

export const RHSPanelListItem = ({
  label,
  value,
  empty = "N/A",
  Icon,
  count,
  valueClassName,
  disabled = false,
  onClick,
}: RHSPanelListItemProps) => {
  const isEmpty = value === undefined || value === null || value === ""

  return (
    <div className="flex flex-row items-center">
      <div className="bg-accent-background p-ui-xs flex items-center justify-center corner-dots border border-accent">
        <Icon size={16} weight="duotone" />
      </div>
      <div className="w-12">
        <Divider className="bg-accent shrink-0" />
      </div>
      <div className="flex flex-row flex-1 self-stretch justify-between items-center px-ui-sm bg-subtle-background bracket bracket-offset-0 bracket-accent">
        <span className="font-bold inline-flex items-center gap-2">
          {count !== undefined ?
            <span className={cn("text-xs font-bold", count > 0 ? "text-terminal" : "text-subtle")}>
              {count}
            </span>
          : null}

          {label}
        </span>
        {onClick && !disabled ?
          <Button
            variant="link"
            size="sm"
            onClick={onClick}
            className="px-0! text-xs"
            disabled={count === 0}
          >
            View <ArrowRightIcon size={16} />
          </Button>
        : <span className={cn(isEmpty || disabled ? "text-subtle" : "", valueClassName)}>
            {isEmpty || disabled ? empty : value}
          </span>
        }
      </div>
    </div>
  )
}
