import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/utils/tailwind";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap duration-300 ease-in-out text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-white/20 hover:text-primary transition-[background,color] focus-hover hover:animate-outline-pulse",
        secondary:
          "bg-primary/[.05] text-secondary-foreground hover:bg-white/20 border-1 border-border hover:border-transparent outline-primary hover:outline-solid transition-[background,color] focus-hover hover:animate-outline-pulse",
        ghost:
          "hover:bg-accent hover:bg-accent/50 focus-hover hover:animate-outline-pulse",
        link: "text-primary underline-offset-4 hover:underline",
        tab: "relative bg-muted/40 text-primary hover:text-muted-foreground hover:bg-subtle/10 hover:text-primary border-1 border-subtle/40 hover:border-subtle/50 before:content-[''] before:absolute before:inset-x-px before:h-0 before:bottom-px before:bg-white/30 hover:before:h-1 before:transition-all before:duration-200 before:ease-in-out focus-outline",
      },
      active: {
        true: "",
        false: "",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        xl: "h-12 px-8 has-[>svg]:px-6 text-base",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
        tab: "size-16 [&_svg:not([class*='size-'])]:size-6 [&_svg:not([class*='z-'])]:z-20",
      },
    },
    compoundVariants: [
      {
        variant: "tab",
        active: true,
        class:
          "hover:bg-terminal/10 bg-terminal/20 border-terminal/60 hover:border-terminal/60 text-terminal-foreground/20 hover:text-terminal-foreground/40 before:bg-terminal-foreground before:shadow-glow-sm before:shadow-terminal-foreground before:h-1",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
      active: false,
    },
  }
);

function Button({
  className,
  variant,
  size,
  active = false,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, active, className }))}
      {...props}
    />
  );
}

export { Button };
