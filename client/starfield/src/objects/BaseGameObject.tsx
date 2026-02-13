import { memo, Suspense, useCallback, useRef } from "react"
import { invalidate, useFrame } from "@react-three/fiber"

import { useGameObjectAnimation } from "@/animations/gameObjectFadeAnim"
import type { PositionedGameObject } from "@/types"
import { useGameStore } from "@/useGameStore"

import { GameObjectFadeContext } from "./useGameObjectFade"

export interface BaseGameObjectProps extends PositionedGameObject {
  children: React.ReactNode
  fadeIn?: boolean
  fadeInDuration?: number
  fadeInDelay?: number
  fadeOutDuration?: number
}

/**
 * Base wrapper for all game objects. Handles:
 * - Fade-in spring animation on mount
 * - Fade-out spring animation when `removing` is true
 * - Automatic removal from the store when fade-out completes
 * - Provides the current fade value (0–1) to children via `useGameObjectFade()`
 *
 * Children handle their own positioning, geometry, and materials.
 */
export const BaseGameObject = memo(function BaseGameObject({
  children,
  id,
  enabled = true,
  removing = false,
  fadeIn = true,
  fadeInDuration = 2000,
  fadeInDelay = 300,
  fadeOutDuration = 1000,
}: BaseGameObjectProps) {
  const fadeRef = useRef(0)

  const removePositionedGameObject = useGameStore(
    (state) => state.removePositionedGameObject
  )

  const onRemoved = useCallback(() => {
    removePositionedGameObject(id)
  }, [id, removePositionedGameObject])

  const updateFade = useGameObjectAnimation({
    duration: fadeInDuration,
    delay: fadeInDelay,
    enabled: fadeIn,
    fadeOutDuration,
    removing,
    onRemoved,
  })

  useFrame(() => {
    fadeRef.current = updateFade()
    // Keep the render loop alive while this object is still fading.
    // The global isAnimating flag can be cleared prematurely when
    // multiple objects fade concurrently, so each object pumps its own invalidate.
    if (fadeRef.current > 0 && fadeRef.current < 1) {
      invalidate()
    }
  })

  if (!enabled) return null

  return (
    <GameObjectFadeContext.Provider value={fadeRef}>
      <Suspense fallback={null}>{children}</Suspense>
    </GameObjectFadeContext.Provider>
  )
}, baseGameObjectPropsAreEqual)

// ---------------------------------------------------------------------------
// Memo comparator — checks every PositionedGameObject field so that children
// (which receive the same object via spread) re-render when any data changes.
// `children` is deliberately excluded; child components handle their own memo.
// ---------------------------------------------------------------------------

function baseGameObjectPropsAreEqual(
  prev: BaseGameObjectProps,
  next: BaseGameObjectProps
): boolean {
  if (
    prev.position[0] !== next.position[0] ||
    prev.position[1] !== next.position[1] ||
    prev.position[2] !== next.position[2]
  ) {
    return false
  }

  return (
    prev.id === next.id &&
    prev.type === next.type &&
    prev.scale === next.scale &&
    prev.opacity === next.opacity &&
    prev.enabled === next.enabled &&
    prev.removing === next.removing &&
    prev.label === next.label &&
    prev.meta === next.meta &&
    prev.fadeIn === next.fadeIn &&
    prev.fadeInDuration === next.fadeInDuration &&
    prev.fadeInDelay === next.fadeInDelay &&
    prev.fadeOutDuration === next.fadeOutDuration &&
    prev.initial === next.initial
  )
}
