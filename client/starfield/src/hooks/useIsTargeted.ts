import { useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

/**
 * Returns true if the given world position is within `thresholdAngle` degrees
 * of the camera's forward direction (center of screen)
 */
export function useIsTargeted(
  position: [number, number, number],
  thresholdAngle = 5 // degrees from center
): boolean {
  const camera = useThree((state) => state.camera)
  const [isTargeted, setIsTargeted] = useState(false)

  // Reusable vectors to avoid allocations
  const objectPos = useRef(new THREE.Vector3())
  const cameraDir = useRef(new THREE.Vector3())
  const toObject = useRef(new THREE.Vector3())

  useFrame(() => {
    // Get camera's forward direction
    camera.getWorldDirection(cameraDir.current)

    // Get direction from camera to object
    objectPos.current.set(...position)
    toObject.current.copy(objectPos.current).sub(camera.position).normalize()

    // Calculate angle between camera forward and direction to object
    const dot = cameraDir.current.dot(toObject.current)
    const angleRad = Math.acos(Math.min(1, Math.max(-1, dot)))
    const angleDeg = THREE.MathUtils.radToDeg(angleRad)

    const nowTargeted = angleDeg <= thresholdAngle
    if (nowTargeted !== isTargeted) {
      setIsTargeted(nowTargeted)
    }
  })

  return isTargeted
}
