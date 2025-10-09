"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as React from "react";

import { cn } from "@/utils/tailwind";

function ToggleControl({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer data-[state=checked]:bg-active/20 data-[state=unchecked]:bg-black focus-visible:border-ring data-[state=checked]:focus-visible:border-active focus-visible:ring-ring/50 data-[state=checked]:focus-visible:ring-active/50 inline-flex h-[25px] w-[46px] shrink-0 items-center border border-border data-[state=checked]:border-active transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
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
