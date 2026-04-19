import { UserIcon } from "@phosphor-icons/react"

import { Button } from "@/components/primitives/Button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Popover"
import { TopBarCreditBalance } from "@/components/TopBarCreditBalance"
import { TopBarDisconnectButton } from "@/components/TopBarDisconnectButton"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

export const TopBarTextItem = ({
  label,
  value,
  className,
}: {
  label?: string
  value: string | undefined
  className?: string
}) => {
  return (
    <div className={cn("flex flex-row gap-1.5 text-xs uppercase min-w-0", className)}>
      {label && <span className="text-subtle-foreground truncate">{label + " "}</span>}
      <span className="text-white font-semibold truncate min-w-0">{value ?? "---"}</span>
    </div>
  )
}

export const TopBar = () => {
  const player = useGameStore.use.player()
  const corporation = useGameStore.use.corporation?.()
  return (
    <header className="relative bg-subtle-background border-b flex flex-row items-center gap-ui-sm shadow-long z-50">
      <div className="flex-1 flex flex-row justify-start gap-1.5 p-1.5">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon-sm">
              <UserIcon weight="bold" size={16} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-fit">
            <div className="flex flex-col gap-ui-xs">
              {player?.name ?
                <span className="text-foreground text-sm">{player.name}</span>
              : <span className="text-foreground text-sm">---</span>}
              {corporation ?
                <span className="text-subtle-foreground text-xs">{corporation.name}</span>
              : <span className="text-subtle-foreground text-xs">---</span>}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="relative h-full shrink-0 w-56">
        <TopBarCreditBalance />
      </div>
      <div className="flex-1 flex flex-row justify-end gap-1.5 p-1.5 items-center">
        <TopBarDisconnectButton />
      </div>
    </header>
  )
}
