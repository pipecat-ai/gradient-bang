import { CircleNotchIcon } from "@phosphor-icons/react"

import { cn } from "@/utils/tailwind"

export const FullScreenLoader = ({
  message,
  className,
}: {
  message?: string
  className?: string
}) => {
  return (
    <div
      className={cn(
        "h-screen w-screen flex items-center justify-center cross-lines-accent cross-lines-offset-50 bg-subtle-background",
        className
      )}
    >
      <div className="flex flex-col items-center justify-center bg-background/60 py-3 px-6 relative z-10 gap-2 bracket bracket-offset-0 bracket-accent-foreground">
        <CircleNotchIcon size={28} weight="duotone" className="animate-spin text-terminal" />
        <span className="uppercase text-xs font-medium animate-pulse">
          {message ?? "Initializing"}
        </span>
      </div>
    </div>
  )
}
