import { cn } from "@/utils/tailwind";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva(
  "inline-flex items-center justify-center uppercase gap-2 whitespace-nowrap duration-300 ease-in-out font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive self-start",
  {
    variants: {
      variant: {
        default: "bg-muted border border-border text-foreground",
      },
      border: {
        none: "",
        bracket: "bracket bracket-offset-1",
        elbow: "elbow elbow-1 elbow-offset-1",
      },
      size: {
        sm: "text-xs px-2 py-1",
        default: "text-sm px-4 py-2",
        lg: "text-base px-6 py-3",
      },
    },
    defaultVariants: {
      variant: "default",
      border: "none",
      size: "default",
    },
    compoundVariants: [
      {
        border: "elbow",
        size: "sm",
        class: "elbow-size-6",
      },
      {
        border: "elbow",
        size: "default",
        class: "elbow-size-10",
      },
      {
        border: "elbow",
        size: "lg",
        class: "elbow-size-15",
      },
      {
        border: "bracket",
        size: "sm",
        class: "bracket-size-6",
      },
      {
        border: "bracket",
        size: "default",
        class: "bracket-size-10",
      },
      {
        border: "bracket",
        size: "lg",
        class: "bracket-size-15",
      },
      {
        border: "elbow",
        variant: "default",
        class: "elbow-muted-foreground/50",
      },
      {
        border: "bracket",
        variant: "default",
        class: "bracket-muted-foreground/50",
      },
    ],
  }
);

export const Badge = ({
  children,
  variant = "default",
  border = "none",
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof badgeVariants>) => {
  return (
    <div
      className={cn(badgeVariants({ variant, border, size }), className)}
      {...props}
    >
      {children}
    </div>
  );
};
