"use client";

import * as React from "react";

import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/utils/tailwind";

function ToggleControl({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer data-[state=checked]:bg-input/10 data-[state=unchecked]:bg-background focus-visible:border-input inline-flex h-[25px] w-[46px] shrink-0 items-center border border-input transition-all disabled:cursor-not-allowed disabled:opacity-50 focus-outline",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-subtle data-[state=checked]:bg-white pointer-events-none block size-[18px] ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%+6px)] data-[state=unchecked]:translate-x-[2px]"
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { ToggleControl };
