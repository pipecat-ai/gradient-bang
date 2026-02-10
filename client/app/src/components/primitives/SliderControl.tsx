"use client"

import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/utils/tailwind"

const sliderVariants = cva(
  "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
  {
    variants: {
      size: {
        default:
          "after:content-[''] after:absolute after:left-2 after:right-2 after:top-1/2 after:-translate-y-1/2 after:h-px after:bg-white/20 after:pointer-events-none",
        lg: "",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

const sliderTrackVariants = cva(
  "relative grow overflow-hidden data-[orientation=vertical]:h-full data-[orientation=horizontal]:w-full",
  {
    variants: {
      size: {
        default:
          "bg-background border border-input data-[orientation=horizontal]:h-[25px] data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:-mr-[3px] data-[orientation=horizontal]:-ml-[3px]",
        lg: "data-[orientation=horizontal]:h-[36px] data-[orientation=vertical]:w-1.5 -mx-[4px]",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

const sliderThumbVariants = cva(
  "border-primary block shrink-0 border bg-white transition-[color,outline] disabled:pointer-events-none disabled:opacity-50 focus-outline",
  {
    variants: {
      size: {
        default: "size-[18px]",
        lg: "size-[26px]",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

function SliderControl({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  size,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & VariantProps<typeof sliderVariants>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value) ? value
      : Array.isArray(defaultValue) ? defaultValue
      : [min, max],
    [value, defaultValue, min, max]
  )

  const slider = (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(sliderVariants({ size }), size !== "lg" && className)}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className={sliderTrackVariants({ size })}>
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="bg-input/20 absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className={sliderThumbVariants({ size })}
        />
      ))}
    </SliderPrimitive.Root>
  )

  if (size === "lg") {
    return (
      <div
        className={cn(
          "relative w-full bg-background border border-input",
          "after:content-[''] after:absolute after:left-2 after:right-2 after:top-1/2 after:-translate-y-1/2 after:h-px after:bg-white/20 after:pointer-events-none",
          className
        )}
      >
        <div className="px-[4px]">{slider}</div>
      </div>
    )
  }

  return slider
}

export { SliderControl }
