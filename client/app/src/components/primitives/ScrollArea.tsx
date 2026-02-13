"use client"

import * as React from "react"

import { cn } from "@/utils/tailwind"

function ScrollArea({
  disabled = false,
  className,
  children,
  onScroll,
  viewportRef,
  ...props
}: React.ComponentProps<"div"> & {
  disabled?: boolean
  /** @deprecated No longer used — scrollbar styling is handled via CSS. Kept for backwards compatibility. */
  classNames?: { scrollbar?: string }
  onScroll?: React.UIEventHandler<HTMLDivElement>
  /** Ref forwarded to the viewport element (the actual scrollable container) */
  viewportRef?: React.Ref<HTMLDivElement>
}) {
  return (
    <div
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <div
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn("size-full", disabled ? "overflow-hidden" : "overflow-auto")}
        onScroll={onScroll}
      >
        {children}
      </div>
    </div>
  )
}

export { ScrollArea }
