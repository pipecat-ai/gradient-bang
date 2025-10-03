import { Badge } from "@pipecat-ai/voice-ui-kit";
import { useAnimatedCounter } from "../hooks/useAnimatedCounter";
import { useFlashAnimation } from "../hooks/useFlashAnimation";

export const NumericalBadge = ({
  value,
  children,
  formatAsCurrency = false,
}: {
  value: number | undefined;
  children: React.ReactNode;
  formatAsCurrency?: boolean;
}) => {
  const { displayValue, isAnimating } = useAnimatedCounter(value, {
    duration: 1200,
    precision: 0,
  });

  const { flashColor, isFlashing } = useFlashAnimation(value, {
    duration: 1000,
    flashDelay: 100,
  });

  return (
    <Badge
      size="lg"
      variant="elbow"
      color={flashColor}
      className={`gap-1 transition-colors duration-200 ${
        isFlashing
          ? flashColor === "active"
            ? "numerical-badge-flashing"
            : "numerical-badge-flashing-inactive"
          : ""
      } ${isAnimating ? "numerical-badge-animating" : ""}`}
    >
      {children}
      <span
        className={`w-10 text-center transition-all duration-150 ${
          value === undefined
            ? "text-subtle"
            : value === 0
            ? "text-white opacity-40"
            : "text-white"
        } ${isAnimating ? "font-semibold" : ""}`}
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
