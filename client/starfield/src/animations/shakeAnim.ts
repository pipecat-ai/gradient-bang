import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
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

// ============================================================================
// Phase State Machine
// ============================================================================

type ShakePhase = "idle" | "rampingUp" | "active" | "settling"

// ============================================================================
// Easing Functions
// ============================================================================

/** Ease-in function for ramp up (slow start, fast end) */
const easeInSine = (t: number): number => 1 - Math.cos((t * Math.PI) / 2)

/** Ease-out function for settle (fast start, slow end) */
const easeOutSine = (t: number): number => Math.sin((t * Math.PI) / 2)

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
 * Uses a simple phase-based state machine instead of springs:
 * - idle: No shaking, useFrame early-returns
 * - rampingUp: Intensity increases from 0 to 1 over rampUpTime
 * - active: Full intensity (1.0), continuous shaking
 * - settling: Intensity decreases from current to 0 over settleTime
 *
 * Registers `cameraShakeAzimuth` and `cameraShakePolar` uniforms that can be
 * consumed by CameraShakeController to apply the shake.
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
 */
export function useShakeAnimation() {
  const setIsShaking = useAnimationStore((state) => state.setIsShaking)

  // ============================================================================
  // Pre-computed noise (generated once on mount)
  // ============================================================================

  // Pre-compute perlin noise arrays - enough for ~10 seconds at 120fps
  const noise = useMemo(
    () => ({
      azimuth: makePNoise1D(20, 1200), // 20 cycles over 1200 samples
      polar: makePNoise1D(20, 1200),
      samplesPerSecond: 120,
    }),
    []
  )

  // ============================================================================
  // State Refs
  // ============================================================================

  // Phase state machine
  const phaseRef = useRef<ShakePhase>("idle")
  const phaseStartTimeRef = useRef(0)

  // Config for current shake
  const configRef = useRef<
    Omit<Required<ShakeConfig>, "duration"> & { duration?: number }
  >(DEFAULT_CONFIG)

  // Time accumulator for shake pattern
  const shakeTimeRef = useRef(0)

  // For one-shot impacts: duration tracking
  const holdEndTimeRef = useRef<number | null>(null)

  // Track intensity at moment of phase transition (for smooth settling)
  const intensityAtSettleStartRef = useRef(1)

  // Track if uniforms are registered
  const uniformsRegistered = useRef(false)

  // ============================================================================
  // Uniform Registration
  // ============================================================================

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

  // ============================================================================
  // Synchronous Cleanup
  // ============================================================================

  const cleanup = useCallback(() => {
    phaseRef.current = "idle"
    holdEndTimeRef.current = null
    setIsShaking(false)

    // Reset uniforms to 0
    const { getUniform, updateUniform } = useUniformStore.getState()
    const azimuth = getUniform<number>("cameraShakeAzimuth")
    const polar = getUniform<number>("cameraShakePolar")
    if (azimuth) updateUniform(azimuth, 0)
    if (polar) updateUniform(polar, 0)
  }, [setIsShaking])

  // ============================================================================
  // Start (idempotent - can be called at any time)
  // ============================================================================

  const start = useCallback(
    (config?: ShakeConfig) => {
      ensureUniforms()

      // Merge with defaults
      const newConfig = { ...DEFAULT_CONFIG, ...config }
      configRef.current = newConfig

      // Reset shake time for fresh pattern
      shakeTimeRef.current = 0

      // Calculate hold end time for one-shot impacts
      if (newConfig.duration !== undefined) {
        const holdTime = Math.max(
          0,
          newConfig.duration - newConfig.rampUpTime - newConfig.settleTime
        )
        // Hold ends at: rampUpTime + holdTime (in ms)
        holdEndTimeRef.current = newConfig.rampUpTime + holdTime
      } else {
        holdEndTimeRef.current = null // Continuous mode
      }

      // Start ramping up
      phaseRef.current = "rampingUp"
      phaseStartTimeRef.current = performance.now()
      intensityAtSettleStartRef.current = 1

      // Mark as active
      setIsShaking(true)

      // Kick off the render loop
      invalidate()
    },
    [ensureUniforms, setIsShaking]
  )

  // ============================================================================
  // Stop (idempotent - can be called at any time)
  // ============================================================================

  const stop = useCallback(() => {
    const currentPhase = phaseRef.current

    // Already idle or settling - nothing to do
    if (currentPhase === "idle") {
      return
    }

    // If already settling, let it continue
    if (currentPhase === "settling") {
      return
    }

    // Calculate current intensity to settle from
    const config = configRef.current
    const elapsed = performance.now() - phaseStartTimeRef.current
    let currentIntensity = 1

    if (currentPhase === "rampingUp") {
      const progress = Math.min(elapsed / config.rampUpTime, 1)
      currentIntensity = easeInSine(progress)
    }

    // Transition to settling
    intensityAtSettleStartRef.current = currentIntensity
    phaseRef.current = "settling"
    phaseStartTimeRef.current = performance.now()
    holdEndTimeRef.current = null
  }, [])

  // ============================================================================
  // Kill (immediate stop without settle)
  // ============================================================================

  const kill = useCallback(() => {
    cleanup()
  }, [cleanup])

  // ============================================================================
  // isActive check
  // ============================================================================

  const isActive = useCallback(() => {
    return phaseRef.current !== "idle"
  }, [])

  // ============================================================================
  // Frame Update Loop
  // ============================================================================

  useFrame((_, rawDelta) => {
    const phase = phaseRef.current

    // Early exit when idle - no work to do
    if (phase === "idle") {
      return
    }

    const config = configRef.current
    const now = performance.now()
    const phaseElapsed = now - phaseStartTimeRef.current

    // Clamp delta to prevent large jumps during long frames
    const delta = Math.min(rawDelta, 0.05)
    shakeTimeRef.current += delta

    // ========================================================================
    // Calculate intensity based on phase
    // ========================================================================

    let intensity = 0

    switch (phase) {
      case "rampingUp": {
        const progress = Math.min(phaseElapsed / config.rampUpTime, 1)
        intensity = easeInSine(progress)

        // Transition to active when ramp complete
        if (phaseElapsed >= config.rampUpTime) {
          phaseRef.current = "active"
          phaseStartTimeRef.current = now
        }
        break
      }

      case "active": {
        intensity = 1

        // Check for duration-based auto-stop
        if (holdEndTimeRef.current !== null) {
          // Calculate total elapsed since start (rampUp + hold time)
          const totalElapsed = config.rampUpTime + phaseElapsed
          if (totalElapsed >= holdEndTimeRef.current) {
            // Time to start settling
            intensityAtSettleStartRef.current = 1
            phaseRef.current = "settling"
            phaseStartTimeRef.current = now
            holdEndTimeRef.current = null
          }
        }
        break
      }

      case "settling": {
        const progress = Math.min(phaseElapsed / config.settleTime, 1)
        const easedProgress = easeOutSine(progress)
        intensity = intensityAtSettleStartRef.current * (1 - easedProgress)

        // Cleanup when settle complete
        if (phaseElapsed >= config.settleTime) {
          cleanup()
          return // Exit early - cleanup sets uniforms to 0
        }
        break
      }
    }

    // ========================================================================
    // Calculate shake angles
    // ========================================================================

    let azimuthAngle = 0
    let polarAngle = 0

    if (intensity > 0.001) {
      if (config.mode === "perlin") {
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

    // ========================================================================
    // Update uniforms
    // ========================================================================

    const { getUniform, updateUniform } = useUniformStore.getState()
    const azimuthUniform = getUniform<number>("cameraShakeAzimuth")
    const polarUniform = getUniform<number>("cameraShakePolar")

    if (azimuthUniform) updateUniform(azimuthUniform, azimuthAngle)
    if (polarUniform) updateUniform(polarUniform, polarAngle)

    // Keep render loop alive while not idle
    invalidate()
  })

  // Register in the animation store (once on mount)
  // Shake functions are already stable due to ref-based state management
  useLayoutEffect(() => {
    useAnimationStore.getState().registerAnimation("shake", {
      start,
      stop,
      kill,
    })
  }, [start, stop, kill])

  // Return for any components that need direct access
  return { isActive }
}
