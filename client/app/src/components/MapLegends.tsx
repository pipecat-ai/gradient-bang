import { AnimatePresence, motion } from "motion/react"
import { StarIcon, SwapIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"

import { DotDivider } from "./primitives/DotDivider"

interface MapLegendNodeProps {
  fillColor?: string
  borderColor?: string
  borderStyle?: "solid" | "dashed"
  size?: number
  className?: string
}

export const MapLegendNode = ({
  fillColor = "transparent",
  borderColor = "currentColor",
  borderStyle = "solid",
  size = 16,
  className,
}: MapLegendNodeProps) => {
  // Regular flat-top hexagon - width:height ratio is 1:0.866 (sqrt(3)/2)
  const hexPoints = "95,43.3 72.5,4.3 27.5,4.3 5,43.3 27.5,82.3 72.5,82.3"

  return (
    <svg width={size} height={size * 0.866} viewBox="0 0 100 86.6" className={className}>
      <polygon
        points={hexPoints}
        fill={fillColor}
        stroke={borderColor}
        strokeWidth={6}
        strokeDasharray={borderStyle === "dashed" ? "12,8" : undefined}
      />
    </svg>
  )
}

interface MapLegendLaneProps {
  oneway?: boolean
  className?: string
}

export const MapLegendLane = ({ oneway = false, className }: MapLegendLaneProps) => {
  return (
    <svg width={18} height={10} viewBox="0 0 18 10" className={className}>
      <line x1={0} y1={5} x2={18} y2={5} stroke="currentColor" strokeWidth={2} />
      {oneway && <polygon points="6,1 12,5 6,9" fill="currentColor" />}
    </svg>
  )
}

export const MapLegend = () => {
  const mapLegendVisible = useGameStore((state) => state.mapLegendVisible)
  return (
    <div className="text-muted-foreground flex flex-row items-center text-xs uppercase border bg-card/60 w-fit overflow-hidden">
      <AnimatePresence>
        {mapLegendVisible && (
          <motion.div
            className="flex flex-row items-center gap-2 px-ui-xs py-ui-xxs"
            initial={{ opacity: 0, x: -20, width: 0 }}
            animate={{ opacity: 1, x: 0, width: "auto" }}
            exit={{ opacity: 0, x: -20, width: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
          >
            <div className="inline-flex items-center gap-1 whitespace-nowrap">
              <MapLegendNode fillColor="#042f2e" borderColor="#5eead4" /> Federation Space
            </div>
            <div className="inline-flex items-center gap-1 whitespace-nowrap">
              <MapLegendNode fillColor="#1e1b4b" borderColor="#818cf8" />
              Neutral
            </div>
            <div className="inline-flex items-center gap-1 whitespace-nowrap">
              <MapLegendNode fillColor="#000000" borderColor="rgba(180,180,180,1)" />
              Unvisited
            </div>
            <div className="inline-flex items-center gap-1 whitespace-nowrap">
              <MapLegendNode
                fillColor="rgba(0,0,0,0.35)"
                borderColor="rgba(180,180,180,1)"
                borderStyle="dashed"
              />
              Corp visited
            </div>
            <DotDivider />
            <div className="inline-flex items-center gap-1 whitespace-nowrap">
              <SwapIcon size={16} weight="bold" className="text-white" />
              Port
            </div>
            <div className="inline-flex items-center gap-1 whitespace-nowrap">
              <StarIcon size={16} weight="fill" className="text-white" />
              Mega Port
            </div>
            <DotDivider />
            <div className="inline-flex items-center gap-1 whitespace-nowrap">
              <MapLegendLane oneway={true} className="text-white" />
              One-way
            </div>
            <div className="inline-flex items-center gap-1 whitespace-nowrap">
              <MapLegendLane oneway={false} className="text-white" />
              Two-way
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
