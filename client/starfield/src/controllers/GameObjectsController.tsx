import { startTransition, useEffect, useMemo, useRef } from "react"
import { useThree } from "@react-three/fiber"
import deepEqual from "fast-deep-equal"
import { button, folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { GAME_OBJECT_TYPES, MAX_SHIPS, PANEL_ORDERING } from "@/constants"
import { useShowControls } from "@/hooks/useStarfieldControls"
import type { GameObject, PositionedGameObject } from "@/types"
import { useGameStore } from "@/useGameStore"

// Positioning defaults
const MIN_RADIUS = 10
const MAX_RADIUS = 50
const MIN_SPACING = 5

// Camera-view spawn bounds (fraction of frustum half-extents)
// Ships spawn between CAMERA_VIEW_INNER and CAMERA_VIEW_OUTER of the frustum
const CAMERA_VIEW_INNER = 0.3 // minimum offset from center (0 = center, 1 = edge)
const CAMERA_VIEW_OUTER = 0.8 // maximum offset from center

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
 * Generates a random point within the camera's view frustum between minRadius
 * and maxRadius. Works in camera-local space (camera looks down -Z) then
 * transforms to world space so the point is always in front of the camera.
 */
function randomPointInCameraView(
  camera: THREE.Camera,
  minRadius: number,
  maxRadius: number
): [number, number, number] {
  const perspCamera = camera as THREE.PerspectiveCamera
  const fov = THREE.MathUtils.degToRad(perspCamera.fov ?? 75)
  const aspect = perspCamera.aspect ?? 1

  // Random distance along the view direction
  const distance = minRadius + Math.random() * (maxRadius - minRadius)

  // Half-extents of the frustum cross-section at this distance
  const halfHeight = Math.tan(fov / 2) * distance
  const halfWidth = halfHeight * aspect

  // Spawn between inner and outer bounds of the frustum, with random sign
  const randBetween = (inner: number, outer: number) => {
    const magnitude = inner + Math.random() * (outer - inner)
    return Math.random() < 0.5 ? -magnitude : magnitude
  }
  const x = randBetween(halfWidth * CAMERA_VIEW_INNER, halfWidth * CAMERA_VIEW_OUTER)
  const y = randBetween(halfHeight * CAMERA_VIEW_INNER, halfHeight * CAMERA_VIEW_OUTER)

  // Position in camera-local space, then transform to world space
  const localPoint = new THREE.Vector3(x, y, -distance)
  const worldPoint = localPoint.applyMatrix4(camera.matrixWorld)

  return [worldPoint.x, worldPoint.y, worldPoint.z]
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
    if (!import.meta.env.DEV) {
      return null
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objectRows: Record<string, any> = {}

    // Add button at the top - use startTransition to prevent Suspense fallback
    objectRows["Add Port"] = button(() => {
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

    objectRows["Add Ship"] = button(() => {
      const currentObjects = useGameStore.getState().gameObjects
      const shipCount =
        currentObjects.filter((o) => o.type === "ship").length + 1
      const newObject: GameObject = {
        id: crypto.randomUUID(),
        type: "ship",
        label: `SHIP-${String(shipCount).padStart(3, "0")}`,
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
            "Game Objects": folder(gameObjectControlsConfig ?? {}, {
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

    // Enforce MAX_SHIPS cap (initial ships establish a floor).
    // Compute the effective list in one pass so positioning and removal
    // happen atomically — no early return / re-trigger needed.
    let effectiveGameObjects = gameObjects
    const allShips = gameObjects.filter((obj) => obj.type === "ship")
    const initialShipCount = allShips.filter((s) => s.initial).length
    const effectiveMax = Math.max(MAX_SHIPS, initialShipCount)

    if (allShips.length > effectiveMax) {
      // Keep only the last `effectiveMax` ships (FIFO eviction from the front)
      const shipsToKeep = new Set(
        allShips.slice(-effectiveMax).map((s) => s.id)
      )
      effectiveGameObjects = gameObjects.filter(
        (obj) => obj.type !== "ship" || shipsToKeep.has(obj.id)
      )
      // Sync the store so Leva controls and other consumers see the trimmed list
      setGameObjects(effectiveGameObjects)
    }

    // Set the ref to the effective list so the re-triggered effect
    // (from setGameObjects above) short-circuits via deepEqual
    prevGameObjectsRef.current = effectiveGameObjects

    // Get current positioned objects directly from store to preserve positions
    const currentPositioned = useGameStore.getState().positionedGameObjects

    // Build a set of active game object IDs for fast lookup
    const activeIds = new Set(effectiveGameObjects.map((obj) => obj.id))

    // Build a map of existing positioned objects by ID
    const existingPositionedById = new Map<string, PositionedGameObject>()
    for (const obj of currentPositioned) {
      existingPositionedById.set(obj.id, obj)
    }

    // If all game objects removed, mark any remaining positioned objects as removing
    // (those already marked removing stay as-is; they'll be cleaned up by their components)
    if (!effectiveGameObjects.length) {
      const remainingObjects = currentPositioned
        .filter((obj) => !obj.removing)
        .map((obj) => ({ ...obj, removing: true }))
      // Keep objects already in removing state too
      const alreadyRemoving = currentPositioned.filter((obj) => obj.removing)
      const combined = [...alreadyRemoving, ...remainingObjects]
      if (combined.length === 0) {
        setPositionedGameObjects([])
      } else {
        setPositionedGameObjects(combined)
      }
      return
    }

    const cameraPosition = cameraRef.current.position.clone()
    const positionedObjects: PositionedGameObject[] = []
    const assignedPositions: [number, number, number][] = []
    const maxAttempts = 100

    // First, collect all existing positions that we'll keep
    for (const obj of effectiveGameObjects) {
      const existing = existingPositionedById.get(obj.id)
      if (existing) {
        assignedPositions.push(existing.position)
      }
    }

    for (const obj of effectiveGameObjects) {
      // Check if this object already has a position
      const existing = existingPositionedById.get(obj.id)
      if (existing) {
        // Preserve existing position, clear removing flag, update other properties
        positionedObjects.push({
          ...obj,
          position: existing.position,
          removing: false,
        })
        continue
      }

      // Generate random position for new object with spacing constraint.
      // Ships are placed within the camera frustum so they're always visible;
      // other objects are placed anywhere in a sphere shell.
      const usesCameraView = obj.type === "ship" && !obj.initial
      const generateCandidate = () =>
        usesCameraView
          ? randomPointInCameraView(cameraRef.current, MIN_RADIUS, MAX_RADIUS)
          : randomPointInSphereShell(cameraPosition, MIN_RADIUS, MAX_RADIUS)

      let position: [number, number, number] | null = null
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = generateCandidate()
        if (isFarEnough(candidate, assignedPositions, MIN_SPACING)) {
          position = candidate
          break
        }
      }

      // Fallback: just use random position without spacing check
      if (!position) {
        position = generateCandidate()
      }

      positionedObjects.push({
        ...obj,
        position,
      })
      assignedPositions.push(position)
    }

    // Keep objects that are being removed (exit animation still playing)
    // and mark newly removed objects as removing
    for (const obj of currentPositioned) {
      if (!activeIds.has(obj.id)) {
        if (obj.removing) {
          // Already removing, keep as-is
          positionedObjects.push(obj)
        } else {
          // Newly removed — mark as removing for exit animation
          positionedObjects.push({ ...obj, removing: true })
        }
      }
    }

    setPositionedGameObjects(positionedObjects)
  }, [gameObjects, setGameObjects, setPositionedGameObjects])

  // This controller doesn't render anything
  return null
}
