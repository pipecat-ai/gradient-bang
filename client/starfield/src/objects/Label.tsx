import { memo } from "react"
import { Html } from "@react-three/drei"

import type { PositionedGameObject } from "@/types"

export type LabelProps = Pick<PositionedGameObject, "position" | "label">

const labelStyle: React.CSSProperties = {
  background: "rgba(0, 0, 0, 0.6)",
  color: "#ffffff",
  padding: "3px 8px",
  fontSize: "11px",
  fontFamily: "monospace",
  whiteSpace: "nowrap",
  pointerEvents: "none",
  userSelect: "none",
  letterSpacing: "0.05em",
}

export const Label = memo(function Label({ position, label }: LabelProps) {
  if (!label) return null

  return (
    <Html
      position={position}
      center
      style={{ pointerEvents: "none" }}
    >
      <div style={{ ...labelStyle, marginTop: "-20px" }}>{label}</div>
    </Html>
  )
})
