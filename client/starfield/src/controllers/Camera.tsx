import { useEffect, useRef } from "react"
import { easings } from "@react-spring/three"
import { CameraControls as CameraControlsImpl } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"
import type { PerspectiveCamera } from "three"

import { useWarpAnimation } from "@/hooks/animations"
import { useAnimationStore } from "@/useAnimationStore"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

import { CameraShakeController } from "./CameraShakeController"

export function CameraController({
  enabled,
  debug = false,
}: {
  enabled: boolean
  debug?: boolean
}) {
  const cameraControlsRef = useRef<CameraControlsImpl>(null)
  const prevLookAtTargetRef = useRef<string | null>(null)
  const transitionDelayFramesRef = useRef(0)
  const pendingTargetRef = useRef<string | null>(null)

  const { cameraBaseFov, hyerpspaceUniforms } = useGameStore(
    (state) => state.starfieldConfig
  )
  const isSceneChanging = useGameStore((state) => state.isSceneChanging)
  const lookAtTarget = useGameStore((state) => state.lookAtTarget)
  const isCameraTransitioning = useGameStore(
    (state) => state.isCameraTransitioning
  )
  const setIsCameraTransitioning = useGameStore(
    (state) => state.setIsCameraTransitioning
  )

  const { invalidate } = useThree()
  const warp = useWarpAnimation()
  const setIsDimmed = useAnimationStore((state) => state.setIsDimmed)

  // Trigger initial invalidation when lookAtTarget changes to kick off the render loop
  useEffect(() => {
    if (lookAtTarget !== prevLookAtTargetRef.current) {
      invalidate()
    }
  }, [lookAtTarget, invalidate])

  // Dim scene when looking at a target, undim when cleared
  useEffect(() => {
    setIsDimmed(lookAtTarget !== null)
  }, [lookAtTarget, setIsDimmed])

  const ANIMATION_DELAY = 0
  const EPSILON = 0.05
  const POST_PROCESSING_ENABLED = true
  // Number of frames to wait before starting camera movement (allows render loop to stabilize)
  const TRANSITION_DELAY_FRAMES = 2

  const [config] = useControls(() => ({
    "Scene Settings": folder({
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
              value: 0.5,
              min: 0.1,
              max: 5,
              step: 0.1,
              label: "Smooth Time",
            },
            restThreshold: {
              value: 2,
              min: 0.001,
              max: 5,
              step: 0.01,
              label: "Rest Threshold",
            },
          }),
        },
        { collapsed: true }
      ),
    }),
  }))

  // Sync Leva config to CameraControls instance
  useEffect(() => {
    if (cameraControlsRef.current) {
      cameraControlsRef.current.smoothTime = config.smoothTime
      cameraControlsRef.current.restThreshold = config.restThreshold
    }
  }, [config.smoothTime, config.restThreshold])

  useFrame(({ camera, gl, scene }) => {
    const perspectiveCamera = camera as PerspectiveCamera
    const cam = cameraControlsRef.current

    // Handle FOV animation during warp
    const progress = warp.progress.get()
    const delayedProgress = THREE.MathUtils.clamp(
      (progress - ANIMATION_DELAY) / (1 - ANIMATION_DELAY),
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

    if (delta > EPSILON) {
      perspectiveCamera.fov = desiredFov
      perspectiveCamera.updateProjectionMatrix()
      invalidate()
    }

    // Handle lookAtTarget changes
    const lookAtTarget = useGameStore.getState().lookAtTarget
    const positionedGameObjects = useGameStore.getState().positionedGameObjects
    const prevTarget = prevLookAtTargetRef.current

    if (cam) {
      // Reset camera when target is cleared (was something, now null)
      if (lookAtTarget === null && prevTarget !== null) {
        cam.setLookAt(0, 0, config.lookAtDistance, 0, 0, 0, true)
        prevLookAtTargetRef.current = null
        pendingTargetRef.current = null
        transitionDelayFramesRef.current = 0
        // Trigger onTargetClear callback
        useCallbackStore.getState().onTargetClear()
      }

      // Detect new target - start delay countdown
      if (
        lookAtTarget &&
        lookAtTarget !== prevTarget &&
        lookAtTarget !== pendingTargetRef.current
      ) {
        pendingTargetRef.current = lookAtTarget
        transitionDelayFramesRef.current = TRANSITION_DELAY_FRAMES
        invalidate() // Ensure we keep rendering during delay
      }

      // Count down delay frames and execute transition when ready
      if (pendingTargetRef.current && transitionDelayFramesRef.current > 0) {
        transitionDelayFramesRef.current--
        invalidate() // Keep rendering during delay
      } else if (
        pendingTargetRef.current &&
        transitionDelayFramesRef.current === 0
      ) {
        // Delay complete - start the actual camera movement
        const gameObject = positionedGameObjects.find(
          (obj) => obj.id === pendingTargetRef.current
        )
        if (gameObject) {
          const targetPosition = new THREE.Vector3(...gameObject.position)
          const direction = new THREE.Vector3()
            .subVectors(cam.camera.position, targetPosition)
            .normalize()

          const newCameraPosition = targetPosition
            .clone()
            .add(direction.multiplyScalar(config.lookAtDistance))

          cam.setLookAt(
            newCameraPosition.x,
            newCameraPosition.y,
            newCameraPosition.z,
            gameObject.position[0],
            gameObject.position[1],
            gameObject.position[2],
            true
          )
          prevLookAtTargetRef.current = pendingTargetRef.current
        }
        pendingTargetRef.current = null
      }
    }

    // Keep invalidating during camera transitions
    if (useGameStore.getState().isCameraTransitioning) {
      invalidate()
    }

    if (!POST_PROCESSING_ENABLED) {
      gl.render(scene, camera)
    }
  }, 1)

  return (
    <>
      <CameraControlsImpl
        makeDefault
        ref={cameraControlsRef}
        enabled={enabled && !isSceneChanging && !isCameraTransitioning}
        smoothTime={config.smoothTime}
        restThreshold={config.restThreshold}
        dollySpeed={0.5}
        truckSpeed={0.5}
        //regress={true} @NOTE: lowers quality on camera movement, toggle on with lower performance profile
        polarRotateSpeed={1}
        azimuthRotateSpeed={1}
        // Disable scroll wheel zooming
        // ACTION values: ROTATE=1, TRUCK=2, DOLLY=8, NONE=0
        mouseButtons={
          debug ? { left: 1, middle: 8, right: 2, wheel: 16 } : undefined
        }
        onTransitionStart={() => {
          // Only set transitioning when we have a look-at target (not for user interactions)
          if (useGameStore.getState().lookAtTarget) {
            setIsCameraTransitioning(true)
          }
          invalidate()
        }}
        onRest={() => {
          setIsCameraTransitioning(false)
          // Trigger onTargetRest callback if we have a target
          const targetId = useGameStore.getState().lookAtTarget
          if (targetId) {
            const target = useGameStore
              .getState()
              .positionedGameObjects.find((obj) => obj.id === targetId)
            if (target) {
              useCallbackStore.getState().onTargetRest(target)
            }
          }
        }}
      />
      {/* Camera shake effect - controlled via isShaking in animation store */}
      <CameraShakeController cameraControlsRef={cameraControlsRef} />
    </>
  )
}
