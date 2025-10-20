import { cn } from "@/utils/tailwind";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const cardVariants = cva("bg-card text-card-foreground flex flex-col", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground border",
      secondary: "bg-secondary/80 backdrop-blur-sm text-secondary-foreground",
    },
    size: {
      default:
        "gap-6 py-6 [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-6",
      lg: "gap-10 py-10 [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-10",
      xl: "gap-12 py-12 [&_*[data-slot^=card-]:not([data-slot^=card-title])]:px-12",
    },
    elbow: {
      true: "elbow",
      false: "",
    },
  },
  defaultVariants: {
    variant: "default",
    elbow: false,
    size: "default",
  },
});
function Card({
  className,
  variant,
  elbow,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ variant, elbow, size }), className)}
      {...props}
    />
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
  CardTitle,
};
