import { Html } from "@react-three/drei"
import { useFrame } from "@react-three/fiber"
import { useRef, useState } from "react"

export function RenderMonitor() {
  const frameCount = useRef(0)
  const [displayCount, setDisplayCount] = useState(0)

  useFrame(() => {
    frameCount.current++
    console.log(`[RENDER] Frame ${frameCount.current}`)
    setDisplayCount(frameCount.current)
  })

  return (
    <Html position={[0, 3, 0]} center>
      <div
        style={{
          background: "rgba(0,0,0,0.8)",
          color: "#0f0",
          padding: "4px 8px",
          fontFamily: "monospace",
          fontSize: "12px",
        }}
      >
        Frame: {displayCount}
      </div>
    </Html>
  )
}
