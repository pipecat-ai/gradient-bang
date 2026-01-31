import { useEffect, useRef, type RefObject } from "react"
import type { CameraControls as CameraControlsImpl } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"

import { useUniformStore } from "@/useUniformStore"

interface CameraShakeControllerProps {
  cameraControlsRef: RefObject<CameraControlsImpl | null>
}

export function CameraShakeController({
  cameraControlsRef,
}: CameraShakeControllerProps) {
  const { invalidate } = useThree()

  // Track previous values for delta calculation
  const lastAzimuthRef = useRef(0)
  const lastPolarRef = useRef(0)

  // Register uniforms on mount if not already registered
  useEffect(() => {
    const { getUniform, registerUniform } = useUniformStore.getState()

    if (!getUniform("cameraShakeAzimuth")) {
      registerUniform("cameraShakeAzimuth", { value: 0 }, { initial: 0 })
    }
    if (!getUniform("cameraShakePolar")) {
      registerUniform("cameraShakePolar", { value: 0 }, { initial: 0 })
    }

    return () => {
      // Reset refs on unmount
      lastAzimuthRef.current = 0
      lastPolarRef.current = 0
    }
  }, [])

  useFrame(() => {
    const cameraControls = cameraControlsRef.current
    if (!cameraControls) return

    const { getUniform } = useUniformStore.getState()

    const azimuthReg = getUniform<number>("cameraShakeAzimuth")
    const polarReg = getUniform<number>("cameraShakePolar")

    if (!azimuthReg || !polarReg) return

    const azimuthAngle = azimuthReg.uniform.value
    const polarAngle = polarReg.uniform.value

    // Skip if no change
    if (
      azimuthAngle === lastAzimuthRef.current &&
      polarAngle === lastPolarRef.current
    ) {
      return
    }

    // Apply delta rotation to camera
    cameraControls.rotate(
      azimuthAngle - lastAzimuthRef.current,
      polarAngle - lastPolarRef.current,
      false
    )

    lastAzimuthRef.current = azimuthAngle
    lastPolarRef.current = polarAngle

    // Request render if there was any shake
    if (azimuthAngle !== 0 || polarAngle !== 0) {
      invalidate()
    }
  })

  return null
}
