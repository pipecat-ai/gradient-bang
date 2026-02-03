import { useCallback, useLayoutEffect, useRef } from "react"
import { easings } from "@react-spring/three"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

import {
  animateProgress,
  lerpAnimatedProperty,
  PROGRESS_THRESHOLD,
  useAnimationSpring,
  type AnimatedPropertyConfig,
  type AnimationConfig,
} from "./useAnimationSpring"

// ============================================================================
// Animation Configuration - tune each property's timing and easing
// ============================================================================

// Camera FOV - subtle zoom during transition
const CAMERA_FOV: AnimatedPropertyConfig = {
  target: 60, // Slight zoom in (less extreme than hyperspace's 150)
  anim: {
    enter: { easing: easings.easeInCubic },
    exit: { easing: easings.easeOutExpo, offset: 0.5 },
  },
}

// Tunnel properties (same as hyperspace)
const TUNNEL_OPACITY: AnimatedPropertyConfig = {
  target: 1,
  anim: {
    enter: { offset: 0.25 },
    exit: { delay: 0.5, offset: 0.9 },
  },
}

const TUNNEL_CONTRAST: AnimatedPropertyConfig = {
  target: 0.7,
  anim: {
    exit: { delay: 0 },
  },
}

const TUNNEL_CENTER_HOLE: AnimatedPropertyConfig = {
  target: 7,
  anim: {
    exit: { delay: 0, offset: 0.5 },
  },
}

const TUNNEL_CENTER_SOFTNESS: AnimatedPropertyConfig = {
  target: 0.5,
  anim: {
    exit: { delay: 0, offset: 0.95 },
  },
}

const TUNNEL_ROTATION_SPEED: AnimatedPropertyConfig = {
  target: 0.01,
  anim: {
    enter: { easing: easings.easeInExpo },
    exit: {},
  },
}

// Exposure - dim the scene during transition
const PP_EXPOSURE: AnimatedPropertyConfig = {
  target: 0.6, // Dim to 60% (hyperspace uses 0.5)
  anim: {
    enter: { easing: easings.easeInQuad },
    exit: { easing: easings.easeOutQuad, offset: 0.3 },
  },
}

// Dithering - subtle visual effect during transition
const PP_DITHERING = {
  gridMultiplier: 2, // Less extreme than hyperspace's 6
  pixelMultiplier: 3,
  anim: {
    enter: { delay: 0.2, easing: easings.easeInQuad },
    exit: { offset: 0.3 },
  },
}

const DEFAULT_ENTER_TIME = 500
const DEFAULT_EXIT_TIME = 500
// ============================================================================

export function useSceneChangeAnimation() {
  const { tunnel: tunnelConfig } = useGameStore(
    (state) => state.starfieldConfig
  )

  // Check if tunnel should be shown during transition
  const shouldShowTunnel =
    tunnelConfig?.enabled || tunnelConfig?.showDuringWarp !== false

  // Track animation direction for useFrame logic
  const directionRef = useRef<"enter" | "exit">("enter")

  // Main progress spring (0 = normal, 1 = in transition)
  const {
    progress,
    getProgress,
    start: startSpring,
    set: setSpring,
  } = useAnimationSpring({
    from: 0,
    config: {
      duration: DEFAULT_ENTER_TIME,
      easing: easings.easeInQuad,
    } as AnimationConfig,
  })

  // Set all uniforms to their "in transition" (progress=1) values
  const setUniformsToTransition = useCallback(() => {
    const { getUniform, updateUniform } = useUniformStore.getState()

    const cameraFov = getUniform<number>("cameraFov")
    if (cameraFov) updateUniform(cameraFov, CAMERA_FOV.target)

    // Tunnel uniforms
    if (shouldShowTunnel) {
      const tunnelOpacity = getUniform<number>("tunnelOpacity")
      if (tunnelOpacity) updateUniform(tunnelOpacity, TUNNEL_OPACITY.target)

      const tunnelContrast = getUniform<number>("tunnelContrast")
      if (tunnelContrast) updateUniform(tunnelContrast, TUNNEL_CONTRAST.target)

      const tunnelCenterHole = getUniform<number>("tunnelCenterHole")
      if (tunnelCenterHole)
        updateUniform(tunnelCenterHole, TUNNEL_CENTER_HOLE.target)

      const tunnelCenterSoftness = getUniform<number>("tunnelCenterSoftness")
      if (tunnelCenterSoftness)
        updateUniform(tunnelCenterSoftness, TUNNEL_CENTER_SOFTNESS.target)

      const tunnelRotationSpeed = getUniform<number>("tunnelRotationSpeed")
      if (tunnelRotationSpeed)
        updateUniform(tunnelRotationSpeed, TUNNEL_ROTATION_SPEED.target)
    }

    const ppExposure = getUniform<number>("ppExposure")
    if (ppExposure) updateUniform(ppExposure, PP_EXPOSURE.target)

    const ppDitheringGridSize = getUniform<number>("ppDitheringGridSize")
    if (ppDitheringGridSize)
      updateUniform(
        ppDitheringGridSize,
        ppDitheringGridSize.initial! * PP_DITHERING.gridMultiplier
      )

    const ppDitheringPixelSizeRatio = getUniform<number>(
      "ppDitheringPixelSizeRatio"
    )
    if (ppDitheringPixelSizeRatio)
      updateUniform(
        ppDitheringPixelSizeRatio,
        ppDitheringPixelSizeRatio.initial! * PP_DITHERING.pixelMultiplier
      )
  }, [shouldShowTunnel])

  // Store the start implementation in a ref (always up-to-date)
  const startRef = useRef<
    (direction: "enter" | "exit", onComplete?: () => void) => void
  >(() => {})

  // Update the ref whenever dependencies change
  useLayoutEffect(() => {
    startRef.current = (
      direction: "enter" | "exit",
      onComplete?: () => void
    ) => {
      directionRef.current = direction

      console.debug("[STARFIELD] Scene change animation:", direction)

      if (direction === "enter") {
        startSpring(1, {
          duration: DEFAULT_ENTER_TIME,
        } as AnimationConfig).then(() => onComplete?.())
      } else {
        // If starting exit from idle state, snap to transition first
        const current = progress.get()
        if (current < PROGRESS_THRESHOLD) {
          setUniformsToTransition()
          setSpring(1)
        }
        startSpring(0, {
          duration: DEFAULT_EXIT_TIME,
        } as AnimationConfig).then(() => onComplete?.())
      }
    }
  }, [startSpring, setSpring, progress, setUniformsToTransition])

  // Register in the animation store (once on mount)
  // The registered function delegates to the ref, so it's always current
  useLayoutEffect(() => {
    useAnimationStore.getState().registerAnimation("sceneChange", {
      start: (direction, onComplete) => startRef.current(direction, onComplete),
    })
  }, [])

  // Animate uniforms each frame based on progress
  useFrame(() => {
    const p = getProgress()
    if (p === null) return

    const isEntering = directionRef.current === "enter"
    console.debug("[SCENE CHANGE] Frame:", { p, isEntering }) // Add this

    const { getUniform, updateUniform } = useUniformStore.getState()

    // --- Camera FOV ---
    const cameraFov = getUniform<number>("cameraFov")
    if (cameraFov) {
      updateUniform(
        cameraFov,
        lerpAnimatedProperty(p, isEntering, cameraFov.initial!, CAMERA_FOV)
      )
    }

    // --- Tunnel uniforms (only animate if tunnel should be shown) ---
    if (shouldShowTunnel) {
      const tunnelOpacity = getUniform<number>("tunnelOpacity")
      if (tunnelOpacity) {
        updateUniform(
          tunnelOpacity,
          lerpAnimatedProperty(
            p,
            isEntering,
            tunnelOpacity.initial!,
            TUNNEL_OPACITY
          )
        )
      }

      const tunnelContrast = getUniform<number>("tunnelContrast")
      if (tunnelContrast) {
        updateUniform(
          tunnelContrast,
          lerpAnimatedProperty(
            p,
            isEntering,
            tunnelContrast.initial!,
            TUNNEL_CONTRAST
          )
        )
      }

      const tunnelCenterHole = getUniform<number>("tunnelCenterHole")
      if (tunnelCenterHole) {
        updateUniform(
          tunnelCenterHole,
          lerpAnimatedProperty(
            p,
            isEntering,
            tunnelCenterHole.initial!,
            TUNNEL_CENTER_HOLE
          )
        )
      }

      const tunnelCenterSoftness = getUniform<number>("tunnelCenterSoftness")
      if (tunnelCenterSoftness) {
        updateUniform(
          tunnelCenterSoftness,
          lerpAnimatedProperty(
            p,
            isEntering,
            tunnelCenterSoftness.initial!,
            TUNNEL_CENTER_SOFTNESS
          )
        )
      }

      const tunnelRotationSpeed = getUniform<number>("tunnelRotationSpeed")
      if (tunnelRotationSpeed) {
        updateUniform(
          tunnelRotationSpeed,
          lerpAnimatedProperty(
            p,
            isEntering,
            tunnelRotationSpeed.initial!,
            TUNNEL_ROTATION_SPEED
          )
        )
      }
    }

    // --- Post-processing: Exposure ---
    const ppExposure = getUniform<number>("ppExposure")
    if (ppExposure) {
      updateUniform(
        ppExposure,
        lerpAnimatedProperty(p, isEntering, ppExposure.initial!, PP_EXPOSURE)
      )
    }

    // --- Dithering effect ---
    const ppDitheringGridSize = getUniform<number>("ppDitheringGridSize")
    const ppDitheringPixelSizeRatio = getUniform<number>(
      "ppDitheringPixelSizeRatio"
    )

    if (ppDitheringGridSize && ppDitheringPixelSizeRatio) {
      const gridInitial = ppDitheringGridSize.initial!
      const pixelInitial = ppDitheringPixelSizeRatio.initial!
      const ditherP = animateProgress(p, isEntering, PP_DITHERING.anim)

      if (ditherP > PROGRESS_THRESHOLD) {
        updateUniform(
          ppDitheringGridSize,
          THREE.MathUtils.lerp(
            gridInitial,
            gridInitial * PP_DITHERING.gridMultiplier,
            ditherP
          )
        )
        updateUniform(
          ppDitheringPixelSizeRatio,
          THREE.MathUtils.lerp(
            pixelInitial,
            pixelInitial * PP_DITHERING.pixelMultiplier,
            ditherP
          )
        )
      } else {
        // Reset to base values when not animating
        updateUniform(ppDitheringGridSize, gridInitial)
        updateUniform(ppDitheringPixelSizeRatio, pixelInitial)
      }
    }
  })

  // Return progress for any components that need to read it
  return { progress }
}
