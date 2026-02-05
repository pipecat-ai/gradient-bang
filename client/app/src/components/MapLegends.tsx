import { StarIcon, SwapIcon } from "@phosphor-icons/react"

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
  return (
    <div className="text-muted-foreground flex flex-row items-center gap-3 text-xs uppercase font-bold border bg-card/60 w-fit p-ui-xs">
      <div className="inline-flex items-center gap-1">
        <MapLegendNode fillColor="#042f2e" borderColor="#5eead4" /> Federation Space
      </div>
      <div className="inline-flex items-center gap-1">
        <MapLegendNode fillColor="#1e1b4b" borderColor="#818cf8" />
        Neutral
      </div>
      <div className="inline-flex items-center gap-1">
        <MapLegendNode fillColor="#000000" borderColor="rgba(180,180,180,1)" />
        Unvisited
      </div>
      <div className="inline-flex items-center gap-1">
        <MapLegendNode
          fillColor="rgba(0,0,0,0.35)"
          borderColor="rgba(180,180,180,1)"
          borderStyle="dashed"
        />
        Corp visited
      </div>
      <DotDivider />
      <div className="inline-flex items-center gap-1">
        <SwapIcon size={16} weight="bold" className="text-white" />
        Port
      </div>
      <div className="inline-flex items-center gap-1">
        <StarIcon size={16} weight="fill" className="text-white" />
        Mega Port
      </div>
      <DotDivider />
      <div className="inline-flex items-center gap-1">
        <MapLegendLane oneway={true} className="text-white" />
        One-way Lane
      </div>
      <div className="inline-flex items-center gap-1">
        <MapLegendLane oneway={false} className="text-white" />
        Two-way Lane
      </div>
    </div>
  )
}
