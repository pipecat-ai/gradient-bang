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
  PROGRESS_THRESHOLD,
  useAnimationSpring,
  type AnimationConfig,
  type PropertyAnimationConfig,
} from "./useAnimationSpring"

// ============================================================================
// Animation Configuration - tune each property's timing and easing
// ============================================================================

// Camera FOV
const CAMERA_FOV = {
  target: 165,
  anim: {
    enter: { easing: easings.easeInCubic },
    exit: { easing: easings.easeOutExpo, offset: 0.5 },
  } satisfies PropertyAnimationConfig,
}

// Tunnel properties
const TUNNEL_OPACITY = {
  target: 1,
  anim: {
    enter: { offset: 0.25 }, // Reaches full opacity at 25% of enter
    exit: { delay: 0.5 }, // Full duration on exit
  } satisfies PropertyAnimationConfig,
}

const TUNNEL_CONTRAST = {
  target: 0.3,
  exit: { delay: 0 },
  anim: {} satisfies PropertyAnimationConfig, // Linear, full duration
}

const TUNNEL_CENTER_HOLE = {
  target: 10,
  exit: { delay: 0, offset: 0.5 }, // Full duration on exit
  anim: {} satisfies PropertyAnimationConfig,
}

const TUNNEL_CENTER_SOFTNESS = {
  target: 1,
  exit: { delay: 0, offset: 0.95 }, // Full duration on exit
  anim: {} satisfies PropertyAnimationConfig,
}

const TUNNEL_ROTATION_SPEED = {
  target: 0.1,
  anim: {
    enter: { easing: easings.easeInExpo },
    exit: {},
  } satisfies PropertyAnimationConfig,
}

// Post-processing
// Exposure: 1.0 = normal, <1 = darker, >1 = brighter
const PP_EXPOSURE = {
  target: 0.5, // 50% darker during hyperspace
  anim: {
    enter: {},
    exit: { offset: 0.4 },
  } satisfies PropertyAnimationConfig,
}

// Layer dim: 1.0 = no dimming, 0 = fully dimmed (black)
// Dims background while keeping game objects visible
const PP_LAYER_DIM_OPACITY = {
  target: 0.15, // Dim background significantly during hyperspace
  anim: {
    enter: { delay: 0.2, easing: easings.easeInQuad },
    exit: { offset: 0.6 },
  } satisfies PropertyAnimationConfig,
}

// Shockwave trigger point during exit animation (0-1 progress, where 1 = in hyperspace, 0 = normal)
// Triggers when progress drops below this value during exit
const SHOCKWAVE_EXIT_TRIGGER = 0.6

// Dithering
const PP_DITHERING = {
  gridMultiplier: 6,
  pixelMultiplier: 6,
  anim: {
    enter: { delay: 0.4, easing: easings.easeInCubic },
    exit: { offset: 0.25 },
  } satisfies PropertyAnimationConfig,
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
      const fovP = animateProgress(p, isEntering, CAMERA_FOV.anim)
      updateUniform(
        cameraFov,
        THREE.MathUtils.lerp(cameraFov.initial!, CAMERA_FOV.target, fovP)
      )
    }

    // --- Tunnel uniforms ---
    const tunnelOpacity = getUniform<number>("tunnelOpacity")
    if (tunnelOpacity) {
      const opacityP = animateProgress(p, isEntering, TUNNEL_OPACITY.anim)
      updateUniform(
        tunnelOpacity,
        THREE.MathUtils.lerp(
          tunnelOpacity.initial!,
          TUNNEL_OPACITY.target,
          opacityP
        )
      )
    }

    const tunnelContrast = getUniform<number>("tunnelContrast")
    if (tunnelContrast) {
      const contrastP = animateProgress(p, isEntering, TUNNEL_CONTRAST.anim)
      updateUniform(
        tunnelContrast,
        THREE.MathUtils.lerp(
          tunnelContrast.initial!,
          TUNNEL_CONTRAST.target,
          contrastP
        )
      )
    }

    const tunnelCenterHole = getUniform<number>("tunnelCenterHole")
    if (tunnelCenterHole) {
      const holeP = animateProgress(p, isEntering, TUNNEL_CENTER_HOLE.anim)
      updateUniform(
        tunnelCenterHole,
        THREE.MathUtils.lerp(
          tunnelCenterHole.initial!,
          TUNNEL_CENTER_HOLE.target,
          holeP
        )
      )
    }

    const tunnelCenterSoftness = getUniform<number>("tunnelCenterSoftness")
    if (tunnelCenterSoftness) {
      const softnessP = animateProgress(
        p,
        isEntering,
        TUNNEL_CENTER_SOFTNESS.anim
      )
      updateUniform(
        tunnelCenterSoftness,
        THREE.MathUtils.lerp(
          tunnelCenterSoftness.initial!,
          TUNNEL_CENTER_SOFTNESS.target,
          softnessP
        )
      )
    }

    const tunnelRotationSpeed = getUniform<number>("tunnelRotationSpeed")
    if (tunnelRotationSpeed) {
      const rotationP = animateProgress(
        p,
        isEntering,
        TUNNEL_ROTATION_SPEED.anim
      )
      updateUniform(
        tunnelRotationSpeed,
        THREE.MathUtils.lerp(
          tunnelRotationSpeed.initial!,
          TUNNEL_ROTATION_SPEED.target,
          rotationP
        )
      )
    }

    // --- Post-processing: Exposure ---
    // Note: initial is 1.0 + exposureAmount from Leva (default 1.0)
    // target is absolute exposure value during hyperspace
    const ppExposure = getUniform<number>("ppExposure")
    if (ppExposure) {
      const exposureP = animateProgress(p, isEntering, PP_EXPOSURE.anim)
      updateUniform(
        ppExposure,
        THREE.MathUtils.lerp(ppExposure.initial!, PP_EXPOSURE.target, exposureP)
      )
    }

    // --- Post-processing: Layer Dim ---
    // Dims background while keeping game objects visible via mask
    const ppLayerDimOpacity = getUniform<number>("ppLayerDimOpacity")
    if (ppLayerDimOpacity) {
      const layerDimP = animateProgress(
        p,
        isEntering,
        PP_LAYER_DIM_OPACITY.anim
      )
      const newValue = THREE.MathUtils.lerp(
        ppLayerDimOpacity.initial!,
        PP_LAYER_DIM_OPACITY.target,
        layerDimP
      )
      updateUniform(ppLayerDimOpacity, newValue)
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
