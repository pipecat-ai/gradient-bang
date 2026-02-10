import { useState } from "react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Popover"
import { ShipDetailsCallout } from "@/components/ShipDetailsCallout"
import { getShipLogoImage } from "@/utils/images"
import { cn } from "@/utils/tailwind"

import { InfoIconSM } from "./svg/InfoIconSM"

export const ShipLogoPopover = ({
  ship_type,
  alt,
  className,
  width = 32,
  height = 32,
  destroyed = false,
  fled = false,
  paid = false,
}: {
  ship_type: string
  alt?: string
  className?: string
  width?: number
  height?: number
  destroyed?: boolean
  fled?: boolean
  paid?: boolean
}) => {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const isInactive = destroyed || fled || paid
  const logoSrc = getShipLogoImage(ship_type)
  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group/ship-logo not-[]:size-6 select-none relative cursor-pointer transition-opacity duration-200 shrink-0",
            popoverOpen ? "opacity-30" : "",
            destroyed ? "cross-lines-destructive"
            : fled ? "cross-lines-warning"
            : paid ? "cross-lines-terminal"
            : "",
            className
          )}
        >
          {logoSrc ?
            <img
              src={logoSrc}
              alt={alt ?? ship_type}
              width={width}
              height={height}
              className={
                isInactive ? "opacity-30"
                : !popoverOpen ?
                  "group-hover/ship-logo:opacity-30"
                : ""
              }
            />
          : <div
              className={cn(
                "flex items-center justify-center rounded bg-muted text-muted-foreground text-[9px] font-bold uppercase leading-none",
                isInactive ? "opacity-30"
                : !popoverOpen ? "group-hover/ship-logo:opacity-30"
                : ""
              )}
              style={{ width, height }}
            >
              {ship_type.slice(0, 2)}
            </div>
          }
          <span className="absolute inset-0 flex items-center justify-center pointer-events-none invisible group-hover/ship-logo:visible">
            <InfoIconSM className="shrink-0 size-3 text-foreground" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" className="w-72">
        <ShipDetailsCallout ship_type={ship_type} />
      </PopoverContent>
    </Popover>
  )
}
