import { useEffect, useMemo, useRef, type RefObject } from "react"
import { easings } from "@react-spring/three"
import type { CameraControls as CameraControlsImpl } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"

import { useAnimationStore } from "@/useAnimationStore"
import { makePNoise1D } from "@/utils/noise"

type ShakeState = "inactive" | "ramping-up" | "active" | "settling"

interface CameraShakeControllerProps {
  cameraControlsRef: RefObject<CameraControlsImpl | null>
}

const ANGULAR_THRESHOLD = 0.0001
const BUFFER_FRAMES = 3

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
            options: { "Perlin Noise": "perlin", Circular: "circular" },
            label: "Shake Mode",
          },
          strength: {
            value: 0.02,
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

  const noiseArrays = useMemo(() => {
    if (config.mode !== "perlin") return null

    const samplesPerSecond = 120
    const durationSeconds = 2
    const length = durationSeconds * config.frequency
    const step = durationSeconds * samplesPerSecond

    return {
      azimuth: makePNoise1D(length, step),
      polar: makePNoise1D(length, step),
      samplesPerSecond,
    }
  }, [config.mode, config.frequency])

  const stateRef = useRef<ShakeState>("inactive")
  const startTimeRef = useRef(0)
  const lastAzimuthRef = useRef(0)
  const lastPolarRef = useRef(0)
  const bufferFramesRef = useRef(0)
  const shakeTimeRef = useRef(0)

  useEffect(() => {
    if (isShaking && stateRef.current === "inactive") {
      stateRef.current = "ramping-up"
      startTimeRef.current = performance.now()
      shakeTimeRef.current = 0
      invalidate()
    } else if (isShaking && stateRef.current === "settling") {
      stateRef.current = "active"
      invalidate()
    } else if (!isShaking && stateRef.current === "active") {
      stateRef.current = "settling"
      startTimeRef.current = performance.now()
    } else if (!isShaking && stateRef.current === "ramping-up") {
      stateRef.current = "settling"
      startTimeRef.current = performance.now()
    }
  }, [isShaking, invalidate])

  useFrame((_, delta) => {
    const cameraControls = cameraControlsRef.current
    if (!cameraControls || stateRef.current === "inactive") return

    const elapsedTime = performance.now() - startTimeRef.current
    let intensity = 0

    switch (stateRef.current) {
      case "ramping-up": {
        const progress = Math.min(elapsedTime / config.rampUpTime, 1)
        intensity = easings.easeInSine(progress)
        shakeTimeRef.current += delta
        if (progress >= 1) stateRef.current = "active"
        invalidate()
        break
      }
      case "active":
        intensity = 1
        shakeTimeRef.current += delta
        invalidate()
        break
      case "settling": {
        const progress = Math.min(elapsedTime / config.settleTime, 1)
        intensity = easings.easeOutSine(1 - progress)
        shakeTimeRef.current += delta

        if (progress >= 1) {
          const magnitude =
            Math.abs(lastAzimuthRef.current) + Math.abs(lastPolarRef.current)
          if (magnitude < ANGULAR_THRESHOLD) {
            if (++bufferFramesRef.current >= BUFFER_FRAMES) {
              stateRef.current = "inactive"
              bufferFramesRef.current = 0
              lastAzimuthRef.current = 0
              lastPolarRef.current = 0
              return
            }
          } else {
            bufferFramesRef.current = 0
          }
        }
        invalidate()
        break
      }
    }

    let azimuthAngle: number
    let polarAngle: number

    if (config.mode === "perlin" && noiseArrays) {
      const sampleIndex =
        Math.floor(shakeTimeRef.current * noiseArrays.samplesPerSecond) %
        noiseArrays.azimuth.length
      azimuthAngle =
        noiseArrays.azimuth[sampleIndex] * config.strength * intensity
      polarAngle = noiseArrays.polar[sampleIndex] * config.strength * intensity
    } else {
      const time = shakeTimeRef.current
      const freq1 = config.frequency * 5.0
      const freq2 = config.frequency * 4.7
      azimuthAngle = Math.sin(time * freq1) * config.strength * intensity
      polarAngle = Math.cos(time * freq2) * config.strength * intensity
    }

    cameraControls.rotate(
      azimuthAngle - lastAzimuthRef.current,
      polarAngle - lastPolarRef.current,
      false
    )

    lastAzimuthRef.current = azimuthAngle
    lastPolarRef.current = polarAngle
  })

  return null
}
