import * as React from "react"

import { cn } from "@/utils/tailwind"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "focus-outline focus-visible:border-foreground focus-visible:bg-background placeholder:text-muted-foreground/80 border-input aria-invalid:ring-destructive/20 aria-invalid:border-destructive disabled:bg-input/50 dark:disabled:bg-input/80 border bg-subtle-background px-2.5 py-2 text-base transition-colors md:text-sm flex field-sizing-content min-h-16 w-full disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
