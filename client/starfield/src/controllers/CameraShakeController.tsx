import { useEffect, useMemo, useRef, type RefObject } from "react"
import { easings } from "@react-spring/three"
import type { CameraControls as CameraControlsImpl } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { useAnimationStore } from "@/useAnimationStore"
import { makePNoise1D } from "@/utils/noise"

type ShakeState = "inactive" | "ramping-up" | "active" | "settling"

interface CameraShakeControllerProps {
  cameraControlsRef: RefObject<CameraControlsImpl | null>
}

export function CameraShakeController({
  cameraControlsRef,
}: CameraShakeControllerProps) {
  const { invalidate } = useThree()
  const isShaking = useAnimationStore((state) => state.isShaking)

  const [config] = useControls(() => ({
    "Scene Settings": folder({
      "Camera Shake": folder(
        {
          mode: {
            value: "circular",
            options: {
              "Perlin Noise": "perlin",
              Circular: "circular",
            },
            label: "Shake Mode",
          },
          strength: {
            value: 0.05,
            min: 0.01,
            max: 5,
            step: 0.01,
            label: "Strength",
          },
          frequency: {
            value: 10,
            min: 1,
            max: 30,
            step: 1,
            label: "Frequency (Hz)",
          },
          rampUpTime: {
            value: 800,
            min: 50,
            max: 1000,
            step: 50,
            label: "Ramp Up Time (ms)",
          },
          settleTime: {
            value: 1500,
            min: 100,
            max: 2000,
            step: 50,
            label: "Settle Time (ms)",
          },
        },
        { collapsed: true }
      ),
    }),
  }))

  // Memoize noise generation - only regenerate when params change (for Perlin mode)
  const noiseArrays = useMemo(() => {
    if (config.mode !== "perlin") return null

    // Generate enough samples for smooth noise (120 samples per second for high quality)
    const samplesPerSecond = 120
    const durationSeconds = 2 // Generate 2 seconds worth of noise
    const length = durationSeconds * config.frequency
    const step = durationSeconds * samplesPerSecond

    return {
      x: makePNoise1D(length, step),
      y: makePNoise1D(length, step),
      z: makePNoise1D(length, step),
      samplesPerSecond,
    }
  }, [config.mode, config.frequency])

  // Track shake state and timing
  const stateRef = useRef<ShakeState>("inactive")
  const startTimeRef = useRef<number>(0)
  const activeStartTimeRef = useRef<number>(0)
  const lastOffsetRef = useRef<THREE.Vector3>(new THREE.Vector3())
  const targetVectorRef = useRef<THREE.Vector3>(new THREE.Vector3())
  const bufferFramesRef = useRef<number>(0)
  const shakeTimeRef = useRef<number>(0)

  // Handle state transitions when isShaking changes
  useEffect(() => {
    if (isShaking && stateRef.current === "inactive") {
      stateRef.current = "ramping-up"
      startTimeRef.current = performance.now()
      shakeTimeRef.current = 0 // Reset shake animation time
      invalidate() // Kick off the render loop
    } else if (isShaking && stateRef.current === "settling") {
      // If shake is requested again while settling, immediately go back to active
      stateRef.current = "active"
      invalidate()
    } else if (!isShaking && stateRef.current === "active") {
      stateRef.current = "settling"
      startTimeRef.current = performance.now()
    } else if (!isShaking && stateRef.current === "ramping-up") {
      // If disabled during ramp-up, go straight to settling
      stateRef.current = "settling"
      startTimeRef.current = performance.now()
    }
  }, [isShaking, invalidate])

  useFrame((_, delta) => {
    const cameraControls = cameraControlsRef.current
    if (!cameraControls) return

    const state = stateRef.current
    if (state === "inactive") return

    const elapsedTime = performance.now() - startTimeRef.current

    let intensity = 0

    if (state === "ramping-up") {
      const progress = Math.min(elapsedTime / config.rampUpTime, 1)
      intensity = easings.easeInSine(progress)
      shakeTimeRef.current += delta

      if (progress >= 1) {
        stateRef.current = "active"
        activeStartTimeRef.current = performance.now()
      }

      invalidate()
    } else if (state === "active") {
      intensity = 1
      shakeTimeRef.current += delta

      invalidate()
    } else if (state === "settling") {
      const progress = Math.min(elapsedTime / config.settleTime, 1)
      intensity = easings.easeOutSine(1 - progress)
      shakeTimeRef.current += delta

      if (progress >= 1) {
        // Settling phase complete, start buffer period
        const offsetMagnitude = lastOffsetRef.current.length()
        const OFFSET_THRESHOLD = 0.001

        if (offsetMagnitude < OFFSET_THRESHOLD) {
          bufferFramesRef.current++

          // Wait for 3 frames at zero offset before stopping
          if (bufferFramesRef.current >= 3) {
            stateRef.current = "inactive"
            bufferFramesRef.current = 0
            lastOffsetRef.current.set(0, 0, 0)
            return
          }
        } else {
          bufferFramesRef.current = 0
        }
      }

      invalidate()
    }

    // Apply shake to camera target
    cameraControls.getTarget(targetVectorRef.current)

    // Calculate offsets based on shake mode
    let offsetX: number, offsetY: number, offsetZ: number

    if (config.mode === "perlin" && noiseArrays) {
      // Perlin noise mode: organic, natural motion
      // Sample the noise array based on elapsed time
      const sampleIndex =
        Math.floor(shakeTimeRef.current * noiseArrays.samplesPerSecond) %
        noiseArrays.x.length
      offsetX = noiseArrays.x[sampleIndex] * config.strength * intensity
      offsetY = noiseArrays.y[sampleIndex] * config.strength * intensity
      offsetZ = noiseArrays.z[sampleIndex] * config.strength * intensity
    } else {
      // Circular mode: sin/cos wave patterns
      const time = shakeTimeRef.current
      const freq1 = config.frequency * 5.0 // 50Hz base at frequency=10
      const freq2 = config.frequency * 4.7 // 47Hz base at frequency=10
      const freq3 = config.frequency * 5.3 // 53Hz for Z axis

      offsetX = Math.sin(time * freq1) * config.strength * intensity
      offsetY = Math.cos(time * freq2) * config.strength * intensity
      offsetZ = Math.sin(time * freq3) * config.strength * intensity * 0.5 // Less Z movement
    }

    // Apply new offset, removing previous offset
    cameraControls
      .normalizeRotations()
      .setTarget(
        targetVectorRef.current.x + offsetX - lastOffsetRef.current.x,
        targetVectorRef.current.y + offsetY - lastOffsetRef.current.y,
        targetVectorRef.current.z + offsetZ - lastOffsetRef.current.z,
        false
      )

    // Store current offset for next frame
    lastOffsetRef.current.set(offsetX, offsetY, offsetZ)
  })

  return null
}
