import { useCallback, useRef } from "react"
import { easings, useSpring } from "@react-spring/three"
import { invalidate, useFrame } from "@react-three/fiber"

import { useAnimationStore } from "@/useAnimationStore"
import { useUniformStore } from "@/useUniformStore"
import { makePNoise1D } from "@/utils/noise"

// ============================================================================
// Animation Configuration
// ============================================================================

export type ShakeMode = "perlin" | "circular"

export interface ShakeConfig {
  /** Shake mode: "perlin" for noise-based, "circular" for smooth circular motion */
  mode?: ShakeMode
  /** Maximum shake strength (in radians) */
  strength?: number
  /** Shake frequency in Hz */
  frequency?: number
  /** Time to ramp up to full intensity (ms) */
  rampUpTime?: number
  /** Time to settle back to zero (ms) */
  settleTime?: number
  /**
   * Total duration for one-shot impacts (ms).
   * When set, shake will: ramp up → hold → ramp down automatically.
   * Duration includes rampUpTime + holdTime + settleTime.
   * If not set, shake runs indefinitely until stop() is called.
   */
  duration?: number
}

const DEFAULT_CONFIG: Omit<Required<ShakeConfig>, "duration"> = {
  mode: "circular",
  strength: 0.01,
  frequency: 10,
  rampUpTime: 500,
  settleTime: 800,
}

const PROGRESS_THRESHOLD = 0.001

// ============================================================================

export interface ShakeAnimationResult {
  /** Start the shake animation (runs indefinitely until stopped) */
  start: (config?: ShakeConfig) => void
  /** Stop the shake animation (with settle) */
  stop: () => void
  /** Immediately stop without settle */
  kill: () => void
  /** Whether currently shaking */
  isActive: () => boolean
}

/**
 * Camera shake animation hook
 *
 * Supports two modes:
 * 1. **Continuous**: Runs indefinitely until stop() is called
 * 2. **One-shot impact**: Runs for a specified duration (ramp up → hold → ramp down)
 *
 * Registers `cameraShakeAzimuth` and `cameraShakePolar` uniforms that can be
 * consumed by any component (typically CameraShakeController) to apply the shake.
 *
 * @example
 * const { start, stop } = useShakeAnimation()
 *
 * // Continuous shake (runs indefinitely)
 * start()
 * start({ strength: 0.02, frequency: 15 })
 * stop() // settles smoothly
 *
 * // One-shot impact (auto-completes)
 * start({ duration: 500 }) // quick impact
 * start({ duration: 1000, strength: 0.03 }) // stronger, longer impact
 * start({ duration: 2000, rampUpTime: 100, settleTime: 500 }) // custom envelope
 */
export function useShakeAnimation(): ShakeAnimationResult {
  const setIsAnimating = useAnimationStore((state) => state.setIsAnimating)

  // Config can be updated on each start()
  const configRef = useRef<Omit<Required<ShakeConfig>, "duration"> & { duration?: number }>(DEFAULT_CONFIG)

  // For one-shot impacts: track elapsed time and when to stop
  const elapsedTimeRef = useRef(0)
  const stopAtTimeRef = useRef<number | null>(null) // null = continuous, number = stop at this elapsed time

  // Track active state separately from spring animation
  // true = shake is running (even when intensity spring is at rest at 1)
  const isActiveRef = useRef(false)

  // Perlin noise arrays (regenerated when config changes)
  const noiseRef = useRef<{
    azimuth: number[]
    polar: number[]
    samplesPerSecond: number
  } | null>(null)

  // Shake time accumulator
  const shakeTimeRef = useRef(0)

  // Intensity spring (0 = no shake, 1 = full intensity)
  // Used for ramping up and settling down
  const [spring, api] = useSpring(() => ({
    intensity: 0,
    config: { duration: DEFAULT_CONFIG.rampUpTime, easing: easings.easeInSine },
    onChange: () => invalidate(),
  }))

  // Register the shake uniforms on mount
  const uniformsRegistered = useRef(false)

  // Ref to hold stop function (avoids circular dependency in start)
  const stopRef = useRef<() => void>(() => {})

  // Generate perlin noise arrays for current config
  const generateNoise = useCallback((frequency: number) => {
    const samplesPerSecond = 120
    const durationSeconds = 2
    const length = durationSeconds * frequency
    const step = durationSeconds * samplesPerSecond

    noiseRef.current = {
      azimuth: makePNoise1D(length, step),
      polar: makePNoise1D(length, step),
      samplesPerSecond,
    }
  }, [])

  // Ensure uniforms are registered
  const ensureUniforms = useCallback(() => {
    if (uniformsRegistered.current) return

    const { registerUniform, getUniform } = useUniformStore.getState()

    if (!getUniform("cameraShakeAzimuth")) {
      registerUniform("cameraShakeAzimuth", { value: 0 }, { initial: 0 })
    }
    if (!getUniform("cameraShakePolar")) {
      registerUniform("cameraShakePolar", { value: 0 }, { initial: 0 })
    }

    uniformsRegistered.current = true
  }, [])

  // Start shaking
  // If duration is set, runs as one-shot impact (ramp up → hold → ramp down)
  // Otherwise runs indefinitely until stop() is called
  const start = useCallback(
    (config?: ShakeConfig) => {
      ensureUniforms()

      // Merge with defaults
      const newConfig = { ...DEFAULT_CONFIG, ...config }
      configRef.current = newConfig

      // Generate noise if using perlin mode
      if (newConfig.mode === "perlin") {
        generateNoise(newConfig.frequency)
      }

      // Reset timers
      shakeTimeRef.current = 0
      elapsedTimeRef.current = 0

      // If duration specified, calculate when to trigger stop (in seconds)
      if (newConfig.duration !== undefined) {
        // Hold time = duration - rampUp - settle
        const holdTime = Math.max(
          0,
          newConfig.duration - newConfig.rampUpTime - newConfig.settleTime
        )
        // Stop at: rampUp + hold (settle happens after stop is called)
        stopAtTimeRef.current = (newConfig.rampUpTime + holdTime) / 1000
      } else {
        stopAtTimeRef.current = null // Continuous mode
      }

      // Mark as active
      isActiveRef.current = true
      setIsAnimating(true)

      // Ramp up intensity
      api.start({
        intensity: 1,
        config: { duration: newConfig.rampUpTime, easing: easings.easeInSine },
      })

      invalidate()
    },
    [ensureUniforms, generateNoise, api, setIsAnimating]
  )

  // Stop with settle animation
  const stop = useCallback(() => {
    // Clear any scheduled stop time
    stopAtTimeRef.current = null

    const config = configRef.current

    // Animate intensity down to 0
    api.start({
      intensity: 0,
      config: { duration: config.settleTime, easing: easings.easeOutSine },
      onRest: () => {
        // Only deactivate when settle completes
        isActiveRef.current = false
        setIsAnimating(false)
      },
    })
  }, [api, setIsAnimating])

  // Keep ref in sync with stop function
  stopRef.current = stop

  // Immediately kill without settle
  const kill = useCallback(() => {
    // Clear any scheduled stop time
    stopAtTimeRef.current = null

    api.stop()
    api.set({ intensity: 0 })
    isActiveRef.current = false
    setIsAnimating(false)

    // Reset uniforms
    const { getUniform, updateUniform } = useUniformStore.getState()
    const azimuth = getUniform<number>("cameraShakeAzimuth")
    const polar = getUniform<number>("cameraShakePolar")
    if (azimuth) updateUniform(azimuth, 0)
    if (polar) updateUniform(polar, 0)
  }, [api, setIsAnimating])

  const isActive = useCallback(() => {
    return isActiveRef.current
  }, [])

  // Update uniforms each frame while active
  useFrame((_, rawDelta) => {
    // Check if active (not just if spring is animating)
    if (!isActiveRef.current) return

    // Clamp delta to prevent large jumps during long frames
    const delta = Math.min(rawDelta, 0.05)
    shakeTimeRef.current += delta
    elapsedTimeRef.current += delta

    // Check if we've reached the scheduled stop time (for one-shot impacts)
    if (
      stopAtTimeRef.current !== null &&
      elapsedTimeRef.current >= stopAtTimeRef.current
    ) {
      stopRef.current()
      // Don't return - continue processing this frame with the settle animation starting
    }

    const intensity = spring.intensity.get()
    const config = configRef.current
    const { getUniform, updateUniform } = useUniformStore.getState()

    let azimuthAngle = 0
    let polarAngle = 0

    if (intensity > PROGRESS_THRESHOLD) {
      if (config.mode === "perlin" && noiseRef.current) {
        const noise = noiseRef.current
        const sampleIndex =
          Math.floor(shakeTimeRef.current * noise.samplesPerSecond) %
          noise.azimuth.length
        azimuthAngle = noise.azimuth[sampleIndex] * config.strength * intensity
        polarAngle = noise.polar[sampleIndex] * config.strength * intensity
      } else {
        // Circular mode
        const time = shakeTimeRef.current
        const freq1 = config.frequency * 5.0
        const freq2 = config.frequency * 4.7
        azimuthAngle = Math.sin(time * freq1) * config.strength * intensity
        polarAngle = Math.cos(time * freq2) * config.strength * intensity
      }
    }

    // Update uniforms
    const azimuthUniform = getUniform<number>("cameraShakeAzimuth")
    const polarUniform = getUniform<number>("cameraShakePolar")

    if (azimuthUniform) updateUniform(azimuthUniform, azimuthAngle)
    if (polarUniform) updateUniform(polarUniform, polarAngle)

    // Keep render loop alive while shaking
    invalidate()
  })

  return {
    start,
    stop,
    kill,
    isActive,
  }
}
