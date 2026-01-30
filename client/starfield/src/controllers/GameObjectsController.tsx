import { useEffect, useRef } from "react"
import { useThree } from "@react-three/fiber"
import deepEqual from "fast-deep-equal"
import * as THREE from "three"

import type { GameObject, PositionedGameObject } from "@/types"
import { useGameStore } from "@/useGameStore"

export interface GameObjectsControllerProps {
  /** Minimum distance from camera (default: 10) */
  minRadius?: number
  /** Maximum distance from camera (default: 50) */
  maxRadius?: number
  /** Minimum distance between objects (default: 5) */
  minSpacing?: number
}

/**
 * Generates a random point on a sphere shell between minRadius and maxRadius
 */
function randomPointInSphereShell(
  center: THREE.Vector3,
  minRadius: number,
  maxRadius: number
): [number, number, number] {
  // Random direction (uniform distribution on sphere)
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)

  // Random radius between min and max
  const radius = minRadius + Math.random() * (maxRadius - minRadius)

  const x = center.x + radius * Math.sin(phi) * Math.cos(theta)
  const y = center.y + radius * Math.sin(phi) * Math.sin(theta)
  const z = center.z + radius * Math.cos(phi)

  return [x, y, z]
}

/**
 * Check if a position is far enough from all existing positions
 */
function isFarEnough(
  position: [number, number, number],
  existingPositions: [number, number, number][],
  minDistance: number
): boolean {
  const pos = new THREE.Vector3(...position)
  for (const existing of existingPositions) {
    if (pos.distanceTo(new THREE.Vector3(...existing)) < minDistance) {
      return false
    }
  }
  return true
}

/**
 * Controller that watches gameObjects from the store, positions them in 3D space
 * around the camera, and outputs positionedGameObjects to the store for rendering
 */
export function GameObjectsController({
  minRadius = 10,
  maxRadius = 50,
  minSpacing = 5,
}: GameObjectsControllerProps = {}) {
  const camera = useThree((state) => state.camera)
  const gameObjects = useGameStore((state) => state.gameObjects)
  const setPositionedGameObjects = useGameStore(
    (state) => state.setPositionedGameObjects
  )
  const prevGameObjectsRef = useRef<GameObject[] | undefined>(undefined)

  // Store camera in ref to avoid dependency issues
  const cameraRef = useRef(camera)
  useEffect(() => {
    cameraRef.current = camera
  }, [camera])

  useEffect(() => {
    // Skip if no change (compare by value, not reference)
    if (deepEqual(prevGameObjectsRef.current, gameObjects)) {
      return
    }
    prevGameObjectsRef.current = gameObjects

    if (!gameObjects.length) {
      setPositionedGameObjects([])
      return
    }

    // Get current positioned objects directly from store to preserve positions
    const currentPositioned = useGameStore.getState().positionedGameObjects

    // Build a map of existing positions by ID
    const existingPositionsById = new Map<string, [number, number, number]>()
    for (const obj of currentPositioned) {
      existingPositionsById.set(obj.id, obj.position)
    }

    const cameraPosition = cameraRef.current.position.clone()
    const positionedObjects: PositionedGameObject[] = []
    const assignedPositions: [number, number, number][] = []
    const maxAttempts = 100

    // First, collect all existing positions that we'll keep
    for (const obj of gameObjects) {
      const existingPosition = existingPositionsById.get(obj.id)
      if (existingPosition) {
        assignedPositions.push(existingPosition)
      }
    }

    for (const obj of gameObjects) {
      // Check if this object already has a position
      const existingPosition = existingPositionsById.get(obj.id)
      if (existingPosition) {
        // Preserve existing position, but update other properties
        positionedObjects.push({
          ...obj,
          position: existingPosition,
        })
        continue
      }

      // Generate random position for new object with spacing constraint
      let position: [number, number, number] | null = null
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = randomPointInSphereShell(
          cameraPosition,
          minRadius,
          maxRadius
        )
        if (isFarEnough(candidate, assignedPositions, minSpacing)) {
          position = candidate
          break
        }
      }

      // Fallback: just use random position without spacing check
      if (!position) {
        position = randomPointInSphereShell(cameraPosition, minRadius, maxRadius)
      }

      positionedObjects.push({
        ...obj,
        position,
      })
      assignedPositions.push(position)
    }

    setPositionedGameObjects(positionedObjects)
  }, [gameObjects, minRadius, maxRadius, minSpacing, setPositionedGameObjects])

  // This controller doesn't render anything
  return null
}
