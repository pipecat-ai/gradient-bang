import * as React from "react";

import { cn } from "@/utils/tailwind";
import { cva, type VariantProps } from "class-variance-authority";

const inputVariants = cva(
  "file:text-foreground placeholder:text-muted-foreground/80 placeholder:uppercase placeholder:text-sm selection:bg-primary selection:text-primary-foreground border-input w-full min-w-0 border bg-transparent text-base transition-[background,color] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "focus-outline bg-background/40 focus-visible:border-foreground focus-visible:bg-background",
      },
      size: {
        default: "h-9 px-32 py-2",
        sm: "h-8 px-2",
        lg: "h-10 px-3",
        xl: "h-12 px-4 py-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Input({
  className,
  type,
  variant,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Input };
