import { cn } from "@/utils/tailwind";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva(
  "inline-flex items-center border justify-center uppercase gap-2 whitespace-nowrap duration-300 ease-in-out font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive self-start",
  {
    variants: {
      variant: {
        default: "bg-muted border-border text-foreground",
        secondary:
          "border-transparent bg-muted/60 text-foreground bracket-muted-foreground/40 elbow-muted-foreground/40",
        count:
          "border-transparent bg-muted/60 motion-safe:bg-muted/50 text-foreground transition-colors duration-500 ",
        countIncrement: "bg-success-background text-success-foreground",
        countDecrement: "bg-warning-background text-warning-foreground",
        highlight:
          "border-transparent bg-fuel/20 text-fuel bracket-fuel bracket-offset-0",
        success:
          "border-success bg-success/20 text-success-foreground bracket-success bracket-offset-0 animate-pulse",
        warning: "border-warning bg-warning-background text-warning-foreground",
      },
      border: {
        none: "",
        bracket: "bracket",
        elbow: "elbow elbow-1",
      },
      size: {
        sm: "text-xs px-2 py-1",
        default: "text-sm px-3 py-3",
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
      {
        variant: ["count", "countIncrement", "countDecrement"],
        border: "elbow",
        class: "-elbow-offset-2",
      },
      {
        variant: ["count", "countIncrement", "countDecrement"],
        border: "bracket",
        class: "-bracket-offset-2",
      },

      {
        variant: "count",
        border: ["elbow", "bracket"],
        class: "elbow-white/30 bracket-white/30",
      },
      {
        variant: "countIncrement",
        border: ["elbow", "bracket"],
        class: "elbow-success bracket-success",
      },
      {
        variant: "countDecrement",
        border: ["elbow", "bracket"],
        class: "elbow-warning bracket-warning",
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

export const BadgeTitle = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <span
      className={cn("uppercase text-xs font-bold tracking-widest", className)}
    >
      {children}
    </span>
  );
};
