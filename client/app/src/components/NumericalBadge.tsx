import { memo } from "react"

import { Badge, BadgeTitle } from "@/components/primitives/Badge"
import { useCounter } from "@/hooks/useCounter"
import { useFlashAnimation } from "@/hooks/useFlashAnimation"
import { cn } from "@/utils/tailwind"

import { LabelText } from "./Label"

/** Isolated component that handles the counter animation to prevent parent re-renders */
const AnimatedValue = memo(
  ({
    value,
    formatAsCurrency,
    duration,
    precision,
    className,
  }: {
    value: number | undefined
    formatAsCurrency: boolean
    duration: number
    precision: number
    className?: string
  }) => {
    const { displayValue } = useCounter(value, {
      duration,
      precision,
    })

    return (
      <BadgeTitle
        className={cn(
          "transition-all duration-150",
          value === undefined ? "text-subtle"
          : value === 0 ? "text-white opacity-40"
          : "text-white",
          className
        )}
      >
        {value === undefined ?
          "---"
        : formatAsCurrency ?
          displayValue.toLocaleString()
        : displayValue}
      </BadgeTitle>
    )
  }
)
AnimatedValue.displayName = "AnimatedValue"

export const NumericalBadge = ({
  label,
  value,
  children,
  formatAsCurrency = false,
  duration = 1500,
  precision = 0,
  className,
  classNames,
  ...props
}: React.ComponentProps<typeof Badge> & {
  label?: string
  value: number | undefined
  formatAsCurrency?: boolean
  duration?: number
  precision?: number
  classNames?: {
    valueContainer?: string
    value?: string
    inner?: string
  }
}) => {
  const { flashColor, isFlashing } = useFlashAnimation(value, {
    duration: 1000,
    flashDelay: 100,
  })

  const variant = flashColor !== "idle" ? flashColor : props.variant

  return (
    <Badge
      {...props}
      variant={variant}
      className={cn(
        "gap-1 transition-colors duration-200",
        isFlashing &&
          (flashColor === "increment" ?
            "numerical-badge-flashing-increment"
          : "numerical-badge-flashing-decrement"),
        className
      )}
    >
      <div className={cn("flex flex-col gap-1 items-center", classNames?.inner)}>
        {label && <LabelText label={label} className="leading-5" />}
        <div
          className={cn(
            "flex flex-row gap-2 items-center leading-none",
            classNames?.valueContainer
          )}
        >
          {children}
          <AnimatedValue
            value={value}
            formatAsCurrency={formatAsCurrency}
            duration={duration}
            precision={precision}
            className={classNames?.value}
          />
        </div>
      </div>
    </Badge>
  )
}
