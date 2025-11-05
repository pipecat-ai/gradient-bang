import { cn } from "@/utils/tailwind";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { ScrollArea } from "./ScrollArea";

const cardVariants = cva("bg-card text-card-foreground flex flex-col", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground border",
      secondary: "bg-secondary/80 backdrop-blur-sm text-secondary-foreground",
    },
    size: {
      none: "",
      default:
        "gap-ui-md py-ui-md [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-md",
      lg: "gap-ui-lg py-ui-lg [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-lg",
      xl: "gap-ui-xl py-ui-xl [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-ui-xl",
    },
    elbow: {
      true: "elbow",
      false: "",
    },
    scrollable: {
      true: "",
      false: "",
    },
  },
  compoundVariants: [
    {
      scrollable: true,
      size: ["none", "default", "lg", "xl"],
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
});

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
      className={cn(
        cardVariants({ variant, elbow, size, scrollable }),
        className
      )}
      {...props}
    />
  );
}

function CardScrollable({ ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card {...props} scrollable={true}>
      <ScrollArea className="w-full h-full max-h-max">
        {props.children}
      </ScrollArea>
    </Card>
  );
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
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("", className)} {...props} />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardScrollable,
  CardTitle,
};
