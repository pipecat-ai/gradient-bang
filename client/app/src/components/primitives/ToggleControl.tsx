"use client"

import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/utils/tailwind"
const toggleControlVariants = cva(
  "peer data-[state=checked]:bg-input/10 data-[state=unchecked]:bg-background focus-visible:border-input inline-flex h-[25px] w-[46px] shrink-0 items-center border border-input transition-all disabled:cursor-not-allowed disabled:opacity-50 focus-outline",
  {
    variants: {
      variant: {
        default: "bg-background/60",
      },
      size: {
        default: "h-[25px] w-[46px]",
        sm: "h-[20px] w-[36px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const toggleControlThumbVariants = cva(
  "bg-subtle data-[state=checked]:bg-white pointer-events-none block size-[18px] ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%+6px)] data-[state=unchecked]:translate-x-[2px]",
  {
    variants: {
      variant: {
        default:
          "bg-subtle data-[state=checked]:bg-white pointer-events-none block size-[18px] ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%+6px)] data-[state=unchecked]:translate-x-[2px]",
      },
      size: {
        default: "size-[18px]",
        sm: "size-[13px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function ToggleControl({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & VariantProps<typeof toggleControlVariants>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(toggleControlVariants({ variant, size }), className)}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(toggleControlThumbVariants({ variant, size }))}
      />
    </SwitchPrimitive.Root>
  )
}

export { ToggleControl }
