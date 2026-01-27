import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"
import { SpinnerIcon } from "@phosphor-icons/react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/utils/tailwind"

const buttonVariants = cva(
  "font-bold inline-flex items-center justify-center gap-2 whitespace-nowrap duration-300 ease-in-out text-sm disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-white/20 hover:text-primary transition-[background,color] focus-hover hover:animate-outline-pulse",
        secondary:
          "bg-primary/[.05] text-secondary-foreground hover:bg-white/20 border-1 border-border hover:border-transparent outline-primary hover:outline-solid transition-[background,color] focus-hover hover:animate-outline-pulse",
        outline:
          "bg-transparent text-secondary-foreground hover:bg-white/20 border-1 border-border hover:border-transparent outline-primary hover:outline-solid transition-[background,color] focus-hover hover:animate-outline-pulse",

        ghost: "hover:bg-accent hover:bg-accent/50 focus-hover hover:animate-outline-pulse",
        link: "text-primary underline-offset-4 hover:underline focus-visible:outline-0",
        tab: "relative bg-gradient-to-t from-transparent via-muted/40 via-50% to-muted/40 text-primary hover:text-muted-foreground hover:via-subtle/20 hover:to-subtle/20 hover:text-primary border border-b-0 [border-image:linear-gradient(to_top,transparent_0%,var(--color-border)_50%)_1] before:content-[''] before:absolute before:inset-x-px before:h-0 before:top-px before:bg-white/30 hover:before:h-1 before:transition-all before:duration-200 before:ease-in-out focus-outline",
        micEnabled:
          "bg-primary/[.05] text-secondary-foreground hover:bg-primary/10 border-1 border-border outline-primary hover:outline-solid transition-[background,color] focus-hover",
        micDisabled:
          "bg-destructive-background/30 text-destructive-foreground border-1 border-destructive-background hover:bg-destructive-background/50 hover:border-destructive transition-[background,color] focus-hover hover:animate-outline-pulse",
      },
      active: {
        true: "",
        false: "",
      },
      loader: {
        none: "",
        stripes: "stripe-bar stripe-bar-animate-1",
        icon: "[&_svg]:animate-spin [&_svg]:size-4",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        xl: "h-12 px-8 has-[>svg]:px-6 text-base",
        icon: "size-9",
        "icon-xs": "size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
        tab: "px-ui-xxs py-ui-sm [&_svg:not([class*='size-'])]:size-6 [&_svg:not([class*='z-'])]:z-20",
      },
    },
    compoundVariants: [
      {
        variant: "tab",
        active: true,
        class:
          "via-terminal/30 to-terminal/30 hover:via-terminal/20 hover:to-terminal/20 [border-image:linear-gradient(to_top,transparent_0%,var(--color-terminal)_50%)_1] text-terminal-foreground/20 hover:text-terminal-foreground/40 before:bg-terminal-foreground before:shadow-glow-sm before:shadow-terminal-foreground before:h-1",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
      active: false,
    },
  }
)

function Button({
  className,
  variant,
  size,
  children,
  active = false,
  asChild = false,
  loader = "none",
  isLoading = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loader?: "none" | "stripes" | "icon"
    isLoading?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  if (isLoading) {
    return (
      <Comp
        data-slot="button"
        className={cn(
          buttonVariants({
            variant,
            size,
            active,
            loader,
          }),
          className
        )}
        {...props}
        disabled
      >
        {loader === "icon" && <SpinnerIcon weight="bold" />}
      </Comp>
    )
  }

  return (
    <Comp
      data-slot="button"
      className={cn(
        buttonVariants({
          variant,
          size,
          active,
        }),
        className
      )}
      {...props}
    >
      {children}
    </Comp>
  )
}

export { Button }
