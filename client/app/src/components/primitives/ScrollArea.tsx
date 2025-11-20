"use client";

import * as React from "react";

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@/utils/tailwind";

function ScrollArea({
  className,
  children,
  fullHeight = false,
  classNames,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  fullHeight?: boolean;
  classNames?: { scrollbar?: string };
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1",
          fullHeight && "h-full *:first:h-full"
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar className={classNames?.scrollbar} />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
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
        orientation === "vertical" &&
          "h-full w-scrollbar border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-scrollbar flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 hover:bg-white"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
