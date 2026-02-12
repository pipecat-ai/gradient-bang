"use client"

import * as React from "react"

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/utils/tailwind"

function ScrollArea({
  disabled = false,
  className,
  children,
  fullHeight = false,
  bottomAlign = false,
  classNames,
  onScroll,
  viewportRef,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** Make the Radix internal wrapper at least viewport height so children can fill the scroll container */
  fullHeight?: boolean
  /** Pin content to the bottom when shorter than the container. Implies fullHeight. */
  bottomAlign?: boolean
  disabled?: boolean
  classNames?: { scrollbar?: string }
  onScroll?: React.UIEventHandler<HTMLDivElement>
  /** Ref forwarded to the Radix Viewport element (the actual scrollable container) */
  viewportRef?: React.Ref<HTMLDivElement>
}) {
  const needsFullHeight = fullHeight || bottomAlign

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1",
          needsFullHeight && "[&>div]:min-h-full"
        )}
        onScroll={onScroll}
      >
        {bottomAlign ?
          <div className="table-cell align-bottom h-full">{children}</div>
        : children}
      </ScrollAreaPrimitive.Viewport>
      {!disabled && <ScrollBar className={classNames?.scrollbar} />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-(--scrollbar-offset) transition-colors select-none z-20",
        orientation === "vertical" && "h-full w-scrollbar border-l border-l-transparent",
        orientation === "horizontal" && "h-scrollbar flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 hover:bg-white"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
