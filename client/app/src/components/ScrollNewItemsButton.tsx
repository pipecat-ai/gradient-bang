import { CaretDownIcon } from "@phosphor-icons/react"

import { Button } from "@/components/primitives/Button"
import { cn } from "@/utils/tailwind"

export const ScrollNewItemsButton = ({
  onClick,
  className,
}: {
  onClick: () => void
  className?: string
}) => {
  return (
    <Button
      onClick={onClick}
      variant="ui"
      size="ui"
      className={cn(
        "absolute bottom-ui-md left-1/2 -translate-x-1/2 z-30 pointer-events-auto will-change animate-in fade-in slide-in-from-bottom-1 animate-duration-1000 gap-1.5 outline-offset-2 outline-foreground hover:outline-2 bg-fuel-background border-fuel text-fuel-foreground shadow-md hover:bg-background",
        className
      )}
    >
      <CaretDownIcon weight="bold" size={12} className="size-3.5" />
      New
    </Button>
  )
}
