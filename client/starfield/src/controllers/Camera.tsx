import { useCallback, useRef, useState } from "react"
import { easings } from "@react-spring/three"
import { CameraControls as CameraControlsImpl } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"
import type { PerspectiveCamera } from "three"

import { useWarpAnimation } from "@/hooks/animations"
import type { PositionedGameObject } from "@/types"
import { useGameStore } from "@/useGameStore"

const DEFAULT_POSITION = new THREE.Vector3(0, 0, 0)

export function CameraController() {
  const cameraControlsRef = useRef<CameraControlsImpl>(null)
  const gameObjects = useGameStore((state) => state.positionedObjects)
  const { invalidate } = useThree()
  const [, setCurrentTarget] = useState<THREE.Vector3 | null>(null)
  const { cameraBaseFov, hyerpspaceUniforms } = useGameStore(
    (state) => state.starfieldConfig
  )
  const warp = useWarpAnimation()

  const animationDelay = 0
  const epsilon = 0.05

  // Leva controls for camera configuration
  const config = useControls(
    {
      Camera: folder(
        {
          enabled: {
            value: true,
            label: "Enable Camera Controls",
          },

          lookAtDistance: {
            value: 8,
            min: 2,
            max: 20,
            step: 0.5,
            label: "Look At Distance",
          },
          Timing: folder({
            smoothTime: {
              value: 1,
              min: 0.1,
              max: 5,
              step: 0.1,
              label: "Smooth Time",
            },
            restThreshold: {
              value: 2,
              min: 0,
              max: 5,
              step: 0.1,
              label: "Rest Threshold",
            },
          }),
        },
        { collapsed: true }
      ),
    },
    [gameObjects]
  )

  useFrame(({ camera }) => {
    const perspectiveCamera = camera as PerspectiveCamera
    const progress = warp.warpProgress.get()
    const delayedProgress = THREE.MathUtils.clamp(
      (progress - animationDelay) / (1 - animationDelay),
      0,
      1
    )

    const easedProgress = warp.isWarping
      ? easings.easeInCubic(delayedProgress)
      : easings.easeOutExpo(delayedProgress)

    const desiredFov = THREE.MathUtils.lerp(
      cameraBaseFov,
      hyerpspaceUniforms.cameraFov,
      easedProgress
    )

    const delta = Math.abs(perspectiveCamera.fov - desiredFov)

    if (delta > epsilon) {
      perspectiveCamera.fov = desiredFov
      perspectiveCamera.updateProjectionMatrix()
      invalidate()
    }
  }, 1)

  const _resetTarget = useCallback(() => {
    if (!cameraControlsRef.current) return

    const cam = cameraControlsRef.current

    invalidate()

    requestAnimationFrame(() => {
      if (cam) {
        cam.setLookAt(
          DEFAULT_POSITION.x,
          DEFAULT_POSITION.y,
          DEFAULT_POSITION.z,
          0,
          0,
          0,
          true
        )
      }
      setCurrentTarget(null)
    })
  }, [invalidate])

  const _lookAtTarget = useCallback(
    async (gameObjectId: string) => {
      const gameObject = gameObjects.find(
        (obj) => obj.id === gameObjectId
      ) as PositionedGameObject

      if (!cameraControlsRef.current || !gameObject) return

      invalidate()

      const cam = cameraControlsRef.current
      const direction = new THREE.Vector3()
        .subVectors(
          cam.camera.position,
          new THREE.Vector3(...gameObject.position)
        )
        .normalize()

      const newCameraPosition = new THREE.Vector3(...gameObject.position).add(
        direction.multiplyScalar(config.lookAtDistance)
      )

      requestAnimationFrame(() => {
        cam.setLookAt(
          newCameraPosition.x,
          newCameraPosition.y,
          newCameraPosition.z,
          gameObject.position[0],
          gameObject.position[1],
          gameObject.position[2],
          true
        )
        setCurrentTarget(newCameraPosition)
      })
    },
    [invalidate, gameObjects, config.lookAtDistance]
  )

  return (
    <CameraControlsImpl
      ref={cameraControlsRef}
      enabled={config.enabled}
      smoothTime={config.smoothTime}
      restThreshold={config.restThreshold}
      dollySpeed={0.5}
      truckSpeed={0.5}
      polarRotateSpeed={11}
      azimuthRotateSpeed={1}
      onTransitionStart={() => {
        console.debug("[STARFIELD CAMERA] Transition started")
      }}
      onRest={() => {
        console.debug(
          "[STARFIELD CAMERA] Transition complete, restoring render mode"
        )
      }}
    />
  )
}
