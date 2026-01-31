import { useCallback, useRef } from "react"
import { easings } from "@react-spring/three"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

import type { DirectionalAnimationHook } from "./types"
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

// Camera FOV
const CAMERA_FOV: AnimatedPropertyConfig = {
  target: 165,
  // start: 90,  // Example: snap to this value when enter begins
  // end: 75,    // Example: animate back to this value on exit
  anim: {
    enter: { easing: easings.easeInCubic },
    exit: { easing: easings.easeOutExpo, offset: 0.5 },
  },
}

// Tunnel properties
const TUNNEL_OPACITY: AnimatedPropertyConfig = {
  target: 1,
  anim: {
    enter: { offset: 0.25 }, // Reaches full opacity at 25% of enter
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
  target: 1,
  anim: {
    exit: { delay: 0, offset: 0.95 },
  },
}

const TUNNEL_ROTATION_SPEED: AnimatedPropertyConfig = {
  target: 0.1,
  anim: {
    enter: { easing: easings.easeInExpo },
    exit: {},
  },
}

// Post-processing
// Exposure: 1.0 = normal, <1 = darker, >1 = brighter
const PP_EXPOSURE: AnimatedPropertyConfig = {
  target: 0.5, // 50% darker during hyperspace
  anim: {
    enter: {},
    exit: { offset: 0.4 },
  },
}

// Layer dim: 1.0 = no dimming, 0 = fully dimmed (black)
// Dims background while keeping game objects visible
const PP_LAYER_DIM_OPACITY: AnimatedPropertyConfig = {
  target: 0.15, // Dim background significantly during hyperspace
  anim: {
    enter: { delay: 0.2, easing: easings.easeInQuad },
    exit: { offset: 0.6 },
  },
}

// Shockwave trigger point during exit animation (0-1 progress, where 1 = in hyperspace, 0 = normal)
// Triggers when progress drops below this value during exit
const SHOCKWAVE_EXIT_TRIGGER = 0.6

// Dithering - uses multipliers on initial values, not AnimatedPropertyConfig
const PP_DITHERING = {
  gridMultiplier: 6,
  pixelMultiplier: 6,
  anim: {
    enter: { delay: 0.4, easing: easings.easeInCubic },
    exit: { offset: 0.25 },
  },
}

// ============================================================================

export function useHyperspaceAnimation(): DirectionalAnimationHook<
  "enter" | "exit"
> {
  const setHyperspace = useAnimationStore((state) => state.setHyperspace)
  const triggerShockwave = useAnimationStore((state) => state.triggerShockwave)

  const { hyperspaceEnterTime, hyperspaceExitTime } = useGameStore(
    (state) => state.starfieldConfig
  )

  // Track animation direction for useFrame logic
  const directionRef = useRef<"enter" | "exit">("enter")
  // Track if shockwave has been triggered this animation cycle
  const shockwaveTriggeredRef = useRef(false)

  // Main progress spring (0 = normal, 1 = in hyperspace)
  const {
    progress,
    getProgress,
    start: startSpring,
    set: setSpring,
  } = useAnimationSpring({
    from: 0,
    config: {
      duration: hyperspaceEnterTime,
      easing: easings.easeInQuad,
    } as AnimationConfig,
    onComplete: () => {
      setHyperspace(undefined)
    },
  })

  // Set all uniforms to their "in hyperspace" (progress=1) values
  const setUniformsToHyperspace = useCallback(() => {
    const { getUniform, updateUniform } = useUniformStore.getState()

    const cameraFov = getUniform<number>("cameraFov")
    if (cameraFov) updateUniform(cameraFov, CAMERA_FOV.target)

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

    const ppExposure = getUniform<number>("ppExposure")
    if (ppExposure) updateUniform(ppExposure, PP_EXPOSURE.target)

    const ppLayerDimOpacity = getUniform<number>("ppLayerDimOpacity")
    if (ppLayerDimOpacity)
      updateUniform(ppLayerDimOpacity, PP_LAYER_DIM_OPACITY.target)

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
  }, [])

  // Start function that triggers both store state and spring
  const start = useCallback(
    (direction: "enter" | "exit", onComplete?: () => void) => {
      directionRef.current = direction
      shockwaveTriggeredRef.current = false // Reset shockwave trigger for new animation
      setHyperspace(direction)

      if (direction === "enter") {
        console.debug("[STARFIELD] Hyperspace entering")
        // Linear spring - per-property easing via applyEasing
        startSpring(1, {
          duration: hyperspaceEnterTime,
        } as AnimationConfig).then(() => onComplete?.())
      } else {
        // If starting exit from idle state, snap to hyperspace first
        const current = progress.get()
        if (current < PROGRESS_THRESHOLD) {
          setUniformsToHyperspace()
          setSpring(1)
        } else {
          console.debug("[STARFIELD] Hyperspace exiting")
        }
        // Linear spring - per-property easing via applyEasing
        startSpring(0, {
          duration: hyperspaceExitTime,
        } as AnimationConfig).then(() => onComplete?.())
      }
    },
    [
      startSpring,
      setSpring,
      progress,
      hyperspaceEnterTime,
      hyperspaceExitTime,
      setHyperspace,
      setUniformsToHyperspace,
    ]
  )

  // Animate uniforms each frame based on progress
  useFrame(() => {
    const p = getProgress()
    if (p === null) return

    const isEntering = directionRef.current === "enter"
    const { getUniform, updateUniform } = useUniformStore.getState()

    // --- Camera FOV ---
    const cameraFov = getUniform<number>("cameraFov")
    if (cameraFov) {
      updateUniform(
        cameraFov,
        lerpAnimatedProperty(p, isEntering, cameraFov.initial!, CAMERA_FOV)
      )
    }

    // --- Tunnel uniforms ---
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

    // --- Post-processing: Exposure ---
    // Note: initial is 1.0 + exposureAmount from Leva (default 1.0)
    // target is absolute exposure value during hyperspace
    const ppExposure = getUniform<number>("ppExposure")
    if (ppExposure) {
      updateUniform(
        ppExposure,
        lerpAnimatedProperty(p, isEntering, ppExposure.initial!, PP_EXPOSURE)
      )
    }

    // --- Post-processing: Layer Dim ---
    // Dims background while keeping game objects visible via mask
    const ppLayerDimOpacity = getUniform<number>("ppLayerDimOpacity")
    if (ppLayerDimOpacity) {
      updateUniform(
        ppLayerDimOpacity,
        lerpAnimatedProperty(
          p,
          isEntering,
          ppLayerDimOpacity.initial!,
          PP_LAYER_DIM_OPACITY
        )
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

    // --- Shockwave trigger on exit ---
    // Trigger shockwave when progress drops below threshold during exit
    if (
      !isEntering &&
      !shockwaveTriggeredRef.current &&
      p < SHOCKWAVE_EXIT_TRIGGER
    ) {
      shockwaveTriggeredRef.current = true
      triggerShockwave()
    }
  })

  return {
    progress,
    start,
  }
}
