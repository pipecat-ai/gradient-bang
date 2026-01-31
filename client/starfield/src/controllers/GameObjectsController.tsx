import { startTransition, useEffect, useMemo, useRef } from "react"
import { useThree } from "@react-three/fiber"
import deepEqual from "fast-deep-equal"
import { button, folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { GAME_OBJECT_TYPES, PANEL_ORDERING } from "@/constants"
import { useShowControls } from "@/hooks/useStarfieldControls"
import type { GameObject, PositionedGameObject } from "@/types"
import { useGameStore } from "@/useGameStore"

// Positioning defaults
const MIN_RADIUS = 5
const MAX_RADIUS = 50
const MIN_SPACING = 5

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
export function GameObjectsController() {
  const showControls = useShowControls()
  const camera = useThree((state) => state.camera)
  const gameObjects = useGameStore((state) => state.gameObjects)
  const setGameObjects = useGameStore((state) => state.setGameObjects)
  const setPositionedGameObjects = useGameStore(
    (state) => state.setPositionedGameObjects
  )
  const setLookAtTarget = useGameStore((state) => state.setLookAtTarget)
  const prevGameObjectsRef = useRef<GameObject[] | undefined>(undefined)

  // Store camera in ref to avoid dependency issues
  const cameraRef = useRef(camera)
  useEffect(() => {
    cameraRef.current = camera
  }, [camera])

  // Build dynamic game object controls
  const gameObjectControlsConfig = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objectRows: Record<string, any> = {}

    // Add button at the top - use startTransition to prevent Suspense fallback
    objectRows["Add Object"] = button(() => {
      const currentObjects = useGameStore.getState().gameObjects
      const portCount =
        currentObjects.filter((o) => o.type === "port").length + 1
      const newObject: GameObject = {
        id: crypto.randomUUID(),
        type: "port",
        label: `PORT-${String(portCount).padStart(3, "0")}`,
      }
      startTransition(() => {
        setGameObjects([...currentObjects, newObject])
      })
    })

    // Clear all button
    objectRows["Clear All"] = button(() => {
      startTransition(() => {
        setGameObjects([])
      })
    })

    // Create controls for each game object (flat, no sub-folders)
    gameObjects.forEach((obj, index) => {
      const shortId = obj.id.slice(0, 8)
      const prefix = `${index + 1}`

      objectRows[`${prefix}_type_${shortId}`] = {
        value: obj.type ?? "port",
        options: GAME_OBJECT_TYPES,
        label: `${prefix}. Type`,
        onChange: (
          value: GameObject["type"],
          _path: string,
          context: { initial: boolean }
        ) => {
          // Skip initial render
          if (context.initial) return
          // Skip if value hasn't changed
          if (value === obj.type) return
          const current = useGameStore.getState().gameObjects
          const updated = current.map((o) =>
            o.id === obj.id ? { ...o, type: value } : o
          )
          startTransition(() => {
            setGameObjects(updated)
          })
        },
      }

      objectRows[`${prefix}_label_${shortId}`] = {
        value: obj.label ?? "",
        label: `${prefix}. Label`,
        onChange: (
          value: string,
          _path: string,
          context: { initial: boolean }
        ) => {
          if (context.initial) return
          if (value === obj.label) return
          const current = useGameStore.getState().gameObjects
          const updated = current.map((o) =>
            o.id === obj.id ? { ...o, label: value || undefined } : o
          )
          startTransition(() => {
            setGameObjects(updated)
          })
        },
      }

      objectRows[`${prefix}_lookAt_${shortId}`] = button(() => {
        setLookAtTarget(obj.id)
      })

      objectRows[`${prefix}_remove_${shortId}`] = button(() => {
        const current = useGameStore.getState().gameObjects
        startTransition(() => {
          setGameObjects(current.filter((o) => o.id !== obj.id))
        })
      })
    })

    return objectRows
  }, [gameObjects, setGameObjects, setLookAtTarget])

  // Leva controls for game objects
  useControls(
    () =>
      (showControls
        ? {
            "Game Objects": folder(gameObjectControlsConfig, {
              collapsed: true,
              order: PANEL_ORDERING.GAME_OBJECTS,
            }),
          }
        : {}) as Schema,
    [gameObjectControlsConfig, showControls]
  )

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
          MIN_RADIUS,
          MAX_RADIUS
        )
        if (isFarEnough(candidate, assignedPositions, MIN_SPACING)) {
          position = candidate
          break
        }
      }

      // Fallback: just use random position without spacing check
      if (!position) {
        position = randomPointInSphereShell(
          cameraPosition,
          MIN_RADIUS,
          MAX_RADIUS
        )
      }

      positionedObjects.push({
        ...obj,
        position,
      })
      assignedPositions.push(position)
    }

    setPositionedGameObjects(positionedObjects)
  }, [gameObjects, setPositionedGameObjects])

  // This controller doesn't render anything
  return null
}
