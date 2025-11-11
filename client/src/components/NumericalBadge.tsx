import { Badge } from "@/components/primitives/Badge";
import { useCounter } from "@/hooks/useCounter";
import { useFlashAnimation } from "@/hooks/useFlashAnimation";
import { cn } from "@/utils/tailwind";

export const NumericalBadge = ({
  value,
  children,
  formatAsCurrency = false,
  duration = 1500,
  precision = 0,
  className,
  variants,
  ...props
}: React.ComponentProps<typeof Badge> & {
  value: number | undefined;
  formatAsCurrency?: boolean;
  duration?: number;
  precision?: number;
  variants?: {
    increment: React.ComponentProps<typeof Badge>["variant"];
    decrement: React.ComponentProps<typeof Badge>["variant"];
  };
}) => {
  const { displayValue } = useCounter(value, {
    duration,
    precision,
  });

  const { flashColor, isFlashing } = useFlashAnimation(value, {
    duration: 1000,
    flashDelay: 100,
  });

  return (
    <Badge
      {...props}
      variant={flashColor !== "idle" ? variants?.[flashColor] : undefined}
      className={cn(
        `gap-1 transition-colors duration-200`,
        isFlashing &&
          (flashColor === "increment"
            ? "numerical-badge-flashing-increment"
            : "numerical-badge-flashing-decrement"),
        className
      )}
    >
      {children}
      <span
        className={cn(
          "transition-all duration-150",
          value === undefined
            ? "text-subtle"
            : value === 0
            ? "text-white opacity-40"
            : "text-white"
        )}
      >
        {value === undefined
          ? "---"
          : formatAsCurrency
          ? displayValue.toLocaleString()
          : displayValue}
      </span>
    </Badge>
  );
};
