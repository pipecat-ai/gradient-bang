"use client"

import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/utils/tailwind"

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
  disabled,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> &
  VariantProps<typeof sliderThumbVariants>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value) ? value
      : Array.isArray(defaultValue) ? defaultValue
      : [min, max],
    [value, defaultValue, min, max]
  )

  const isVertical = orientation === "vertical"
  const resolvedSize = size ?? "default"

  return (
    <div
      className={cn(
        "relative bg-background border border-input",
        isVertical ? "w-fit" : "w-full",
        isVertical
          ? "after:content-[''] after:absolute after:top-2 after:bottom-2 after:left-1/2 after:-translate-x-1/2 after:w-px after:bg-white/20 after:pointer-events-none"
          : "after:content-[''] after:absolute after:left-2 after:right-2 after:top-1/2 after:-translate-y-1/2 after:h-px after:bg-white/20 after:pointer-events-none",
        disabled && "opacity-50 pointer-events-none",
        className
      )}
    >
      <div
        className={cn(
          isVertical ? "h-full" : "w-full",
          resolvedSize === "lg" ? "p-1.25" : "p-panel-gap"
        )}
      >
        <SliderPrimitive.Root
          data-slot="slider"
          defaultValue={defaultValue}
          value={value}
          min={min}
          max={max}
          disabled={disabled}
          orientation={orientation}
          className="relative flex w-full touch-none items-center select-none data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col"
          {...props}
        >
          <SliderPrimitive.Track
            data-slot="slider-track"
            className={cn(
              "relative grow data-[orientation=vertical]:h-full data-[orientation=horizontal]:w-full",
              resolvedSize === "lg"
                ? "data-[orientation=horizontal]:h-6.5 data-[orientation=vertical]:w-6.5"
                : "data-[orientation=horizontal]:h-4.5 data-[orientation=vertical]:w-4.5"
            )}
          >
            <SliderPrimitive.Range
              data-slot="slider-range"
              className={cn(
                "bg-input/20 absolute",
                isVertical
                  ? resolvedSize === "lg"
                    ? "-inset-x-1.25 -mb-1.25"
                    : "-inset-x-panel-gap -mb-panel-gap"
                  : resolvedSize === "lg"
                    ? "-inset-y-1.25 -ml-1.25"
                    : "-inset-y-panel-gap -ml-panel-gap"
              )}
            />
          </SliderPrimitive.Track>
          {Array.from({ length: _values.length }, (_, index) => (
            <SliderPrimitive.Thumb
              data-slot="slider-thumb"
              key={index}
              className={sliderThumbVariants({ size: resolvedSize })}
            />
          ))}
        </SliderPrimitive.Root>
      </div>
    </div>
  )
}

export { SliderControl }
