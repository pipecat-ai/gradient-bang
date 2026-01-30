import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"
import { motion } from "motion/react"

import { cn } from "@/utils/tailwind"

import { ScrollArea } from "./ScrollArea"

const cardVariants = cva("text-card-foreground flex flex-col", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground border",
      secondary: "bg-secondary/80 motion-safe:backdrop-blur-sm text-secondary-foreground",
      stripes: "bg-card shrink-0 stripe-frame",
      scanlines: "border text-white bg-scanlines",
    },
    size: {
      none: "",
      xxs: "gap-ui-xxs py-ui-xs [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-xs",
      xs: "gap-ui-xs py-ui-xs [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-xs",
      sm: "gap-ui-sm py-ui-sm [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-sm",
      default: "gap-ui-md py-ui-md [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-md",
      lg: "gap-ui-lg py-ui-lg [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-lg",
      xl: "gap-ui-xl py-ui-xl [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-xl",
      panel:
        "gap-panel-gap py-panel-gap [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-panel-gap",
    },
    elbow: {
      true: "elbow elbow-offset-6",
      false: "",
    },
    scrollable: {
      true: "",
      false: "",
    },
  },
  compoundVariants: [
    {
      variant: "stripes",
      size: "xxs",
      class: "stripe-frame-ui-xxs",
    },
    {
      variant: "stripes",
      size: "xs",
      class: "stripe-frame-ui-xs",
    },
    {
      variant: "stripes",
      size: "default",
      class: "stripe-frame-ui-md",
    },
    {
      variant: "stripes",
      size: "lg",
      class: "stripe-frame-ui-lg",
    },
    {
      variant: "stripes",
      size: "xl",
      class: "stripe-frame-ui-xl",
    },
    {
      scrollable: true,
      size: ["none", "default", "sm", "lg", "xl"],
      class: "py-0",
    },
    {
      scrollable: true,
      size: "default",
      class: "[&_*[data-slot^=scroll-area-viewport]]:py-ui-md",
    },
    {
      scrollable: true,
      size: "lg",
      class: "[&_*[data-slot^=scroll-area-viewport]]:py-ui-lg",
    },
    {
      scrollable: true,
      size: "xl",
      class: "[&_*[data-slot^=scroll-area-viewport]]:py-ui-xl",
    },
  ],
  defaultVariants: {
    variant: "default",
    elbow: false,
    size: "default",
    scrollable: false,
  },
})

function Card({
  className,
  variant,
  elbow,
  size,
  scrollable,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ variant, elbow, size, scrollable }), className)}
      {...props}
    />
  )
}

function CardScrollable({ ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card {...props} scrollable={true}>
      <ScrollArea className="w-full h-full max-h-max">{props.children}</ScrollArea>
    </Card>
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-bold text-sm uppercase", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("", className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center", className)} {...props} />
}

const MotionCard = motion.create(Card)

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardScrollable,
  CardTitle,
  MotionCard,
}
