import { usePrevious } from "@uidotdev/usehooks"

import { Badge, BadgeTitle } from "@/components/primitives/Badge"
import { useFlashAnimation } from "@/hooks/useFlashAnimation"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { RESOURCE_SHORT_NAMES } from "@/types/constants"

const formatCargoWithStyledZeros = (value: number) => {
  if (value < 0) return <span className="opacity-50">000</span>

  const padded = value.toString().padStart(3, "0")

  // If value is 0, all digits should have reduced opacity
  if (value === 0) {
    return <span className="opacity-50">{padded}</span>
  }

  const valueStr = value.toString()
  const paddingLength = padded.length - valueStr.length

  if (paddingLength === 0) {
    return <span>{padded}</span>
  }

  const leadingZeros = padded.slice(0, paddingLength)
  const significantDigits = padded.slice(paddingLength)

  return (
    <>
      <span className="opacity-50">{leadingZeros}</span>
      <span>{significantDigits}</span>
    </>
  )
}

export const CargoResourceBadge = ({
  resource,
  value,
  className,
}: {
  resource: Resource
  value: number
  className?: string
}) => {
  const previousValue = usePrevious(value)
  const gameState = useGameStore.use.gameState()
  const { flashColor, isFlashing } = useFlashAnimation(value, {
    duration: 500,
    flashDelay: 100,
  })

  const shouldFlash =
    isFlashing && gameState === "ready" && previousValue !== value

  return (
    <Badge
      variant={
        shouldFlash
          ? flashColor === "increment"
            ? "countIncrement"
            : "countDecrement"
          : "count"
      }
      border="elbow"
      className={cn("gap-1", className)}
    >
      <BadgeTitle>{RESOURCE_SHORT_NAMES[resource as Resource]}</BadgeTitle>
      <BadgeTitle>{formatCargoWithStyledZeros(value)}</BadgeTitle>
    </Badge>
  )
}
