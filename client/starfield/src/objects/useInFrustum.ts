import { useEffect, useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { FRUSTUM_INNER_BOUNDS } from "@/constants"
import type { PositionedGameObject } from "@/types"
import { useGameStore } from "@/useGameStore"

// Reused across all hook instances to avoid GC pressure
const _vec3 = new THREE.Vector3()

/**
 * Test whether a single NDC-projected point is inside the given bounds.
 */
function isInBounds(
  position: [number, number, number],
  camera: THREE.Camera,
  bounds: number
): boolean {
  _vec3.set(position[0], position[1], position[2])
  _vec3.project(camera) // world → NDC: x,y in [-1,1], z = depth

  return (
    Math.abs(_vec3.x) <= bounds &&
    Math.abs(_vec3.y) <= bounds &&
    _vec3.z >= -1 &&
    _vec3.z <= 1 // in front of camera
  )
}

/**
 * Returns a ref that is `true` when the given world position falls within the
 * inner portion of the camera frustum (i.e., near the center of the view).
 *
 * Uses NDC (Normalized Device Coordinates) projection: the full camera frustum
 * maps to [-1, 1] on each axis. A `bounds` of 0.8 means the inner 80% of the
 * view; 0.5 means the inner 50%, etc.
 *
 * Returns a ref (not state) to avoid re-renders every frame — read `.current`
 * inside useFrame, just like `useGameObjectFade`.
 *
 * @param position - World-space position [x, y, z] to test
 * @param bounds  - 0 = dead center only, 1 = full frustum edge. Default 0.8.
 *
 * @example
 * const inFrustumRef = useInFrustum(position, 0.7)
 * useFrame(() => {
 *   if (inFrustumRef.current) {
 *     // Object is in the central 70% of the view
 *   }
 * })
 */
export function useInFrustum(
  position: [number, number, number],
  bounds: number = 0.8
): React.RefObject<boolean> {
  const resultRef = useRef(false)
  const { camera } = useThree()

  useFrame(() => {
    resultRef.current = isInBounds(position, camera, bounds)
  })

  return resultRef
}

/**
 * Batch version: checks all game objects and returns the Set of IDs that fall
 * within the inner frustum bounds.
 *
 * Only triggers a React re-render when objects enter or leave the bounds —
 * not every frame.
 *
 * @param objects - Array of positioned game objects to test
 * @param bounds - 0 = dead center only, 1 = full frustum edge. Default 0.8.
 *
 * @example
 * const inFrustumIds = useObjectsInFrustum(positionedGameObjects, 0.7)
 * // inFrustumIds is a Set<string> of object IDs currently in the central 70%
 */
const EMPTY_SET = new Set<string>()

export function useObjectsInFrustum(
  objects: PositionedGameObject[],
  bounds: number = FRUSTUM_INNER_BOUNDS
): Set<string> {
  const [inFrustum, setInFrustum] = useState<Set<string>>(() => new Set())
  const prevIdsRef = useRef<Set<string>>(new Set())
  const objectsRef = useRef(objects)
  const lookAtTarget = useGameStore((state) => state.lookAtTarget)
  const isSceneChanging = useGameStore((state) => state.isSceneChanging)
  const isCameraTransitioning = useGameStore((state) => state.isCameraTransitioning)
  const { camera } = useThree()

  // Sync ref in an effect to avoid "Cannot access refs during render"
  useEffect(() => {
    objectsRef.current = objects
  }, [objects])

  // Objects must be seen outside the bounds at least once before they can
  // appear in the result set. This prevents labels from showing on load —
  // they only appear once the camera moves an object out and it re-enters.
  const seenOutsideRef = useRef<Set<string>>(new Set())

  useFrame(() => {
    // Skip frustum checks when there's a lookAt target, scene is changing,
    // or the camera is transitioning (e.g. animating back from a target)
    if (lookAtTarget || isSceneChanging || isCameraTransitioning) {
      if (prevIdsRef.current.size > 0) {
        prevIdsRef.current = EMPTY_SET
        setInFrustum(EMPTY_SET)
      }
      return
    }

    const current = new Set<string>()
    for (const obj of objectsRef.current) {
      if (obj.removing) continue

      if (isInBounds(obj.position, camera, bounds)) {
        // Only include if we've previously seen it outside the bounds
        if (seenOutsideRef.current.has(obj.id)) {
          current.add(obj.id)
        }
      } else {
        // Mark as having been outside the bounds
        seenOutsideRef.current.add(obj.id)
      }
    }

    // Only update state when the set actually changes
    const prev = prevIdsRef.current
    if (
      current.size !== prev.size ||
      ![...current].every((id) => prev.has(id))
    ) {
      prevIdsRef.current = current
      setInFrustum(current)
    }
  })

  return inFrustum
}
