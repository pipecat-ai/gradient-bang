"use client";

import * as React from "react";

import { cva, type VariantProps } from "class-variance-authority";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { cn } from "@/utils/tailwind";

const separatorVariants = cva("bg-border text-muted-foreground/30 shrink-0", {
  variants: {
    orientation: {
      horizontal: "h-px w-full",
      vertical: "h-full w-px",
    },
    variant: {
      solid: "",
      dashed:
        "bg-transparent bg-[repeating-linear-gradient(to_right,currentColor,currentColor_10px,transparent_10px,transparent_15px)] bg-[length:15px_100%]",
      dotted:
        "bg-transparent bg-[repeating-linear-gradient(to_right,currentColor,currentColor_2px,transparent_2px,transparent_6px)] bg-[length:6px_100%]",
    },
  },
  compoundVariants: [
    {
      orientation: "vertical",
      variant: "dashed",
      className:
        "bg-transparent bg-[repeating-linear-gradient(to_bottom,currentColor,currentColor_10px,transparent_10px,transparent_15px)] bg-[length:15px_100%]",
    },
    {
      orientation: "vertical",
      variant: "dotted",
      className:
        "bg-transparent bg-[repeating-linear-gradient(to_bottom,currentColor,currentColor_2px,transparent_2px,transparent_6px)] bg-[length:6px_100%]",
    },
  ],
  defaultVariants: {
    orientation: "horizontal",
  },
});
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  variant = "solid",
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root> &
  VariantProps<typeof separatorVariants>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(separatorVariants({ orientation, variant }), className)}
      {...props}
    />
  );
}

export { Separator };
