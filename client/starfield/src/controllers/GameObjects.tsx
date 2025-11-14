import { button, folder, useControls } from "leva";
import { useEffect, useState } from "react";
import { useGameStore } from "../stores/useGameStore";

import { GameObject, GameObjectBounds, PositionedGameObject } from "../types";

interface GameObjectsProps {
  gameObjects: GameObject[];
}

/**
 * Controller component for managing game objects in the scene
 * Handles positioning, bounds checking, and rendering
 */
export function GameObjects({ gameObjects }: GameObjectsProps) {
  const [positionedObjects, setPositionedObjects] = useState<
    PositionedGameObject[]
  >([]);
  const setStoreObjects = useGameStore((state) => state.setPositionedObjects);

  // Leva controls for game object configuration
  const config = useControls(
    {
      "Game Objects": folder({
        minDistance: {
          value: 5,
          min: 1,
          max: 20,
          step: 0.5,
          label: "Min Distance",
        },
        boundsX: {
          value: [-30, 30],
          min: -100,
          max: 100,
          step: 1,
          label: "Bounds X",
        },
        boundsY: {
          value: [-20, 20],
          min: -100,
          max: 100,
          step: 1,
          label: "Bounds Y",
        },
        boundsZ: {
          value: [-30, 30],
          min: -100,
          max: 100,
          step: 1,
          label: "Bounds Z",
        },
        "Regenerate Positions": button(() => {
          regeneratePositions();
        }),
      }),
    },
    { collapsed: true }
  );

  /**
   * Calculate random position within bounds
   */
  const getRandomPosition = (
    bounds: GameObjectBounds
  ): [number, number, number] => {
    const x = bounds.x[0] + Math.random() * (bounds.x[1] - bounds.x[0]);
    const y = bounds.y[0] + Math.random() * (bounds.y[1] - bounds.y[0]);
    const z = bounds.z[0] + Math.random() * (bounds.z[1] - bounds.z[0]);
    return [x, y, z];
  };

  /**
   * Check if position is valid (not too close to existing objects)
   */
  const isPositionValid = (
    position: [number, number, number],
    existingPositions: [number, number, number][],
    minDistance: number
  ): boolean => {
    for (const existingPos of existingPositions) {
      const dx = position[0] - existingPos[0];
      const dy = position[1] - existingPos[1];
      const dz = position[2] - existingPos[2];
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < minDistance) {
        return false;
      }
    }
    return true;
  };

  /**
   * Generate positions for all game objects
   */
  const generatePositions = (
    objects: GameObject[],
    bounds: GameObjectBounds,
    minDistance: number,
    maxAttempts: number = 100
  ): PositionedGameObject[] => {
    const positioned: PositionedGameObject[] = [];
    const positions: [number, number, number][] = [];

    for (const obj of objects) {
      let attempts = 0;
      let position: [number, number, number] | null = null;

      while (attempts < maxAttempts) {
        const candidatePosition = getRandomPosition(bounds);
        if (isPositionValid(candidatePosition, positions, minDistance)) {
          position = candidatePosition;
          break;
        }
        attempts++;
      }

      if (position) {
        positions.push(position);
        positioned.push({
          ...obj,
          position,
        });
      } else {
        console.warn(
          `Failed to place object ${obj.id} after ${maxAttempts} attempts`
        );
      }
    }

    return positioned;
  };

  /**
   * Regenerate positions for all objects
   */
  const regeneratePositions = () => {
    const bounds: GameObjectBounds = {
      x: config.boundsX as [number, number],
      y: config.boundsY as [number, number],
      z: config.boundsZ as [number, number],
    };

    const newPositioned = generatePositions(
      gameObjects,
      bounds,
      config.minDistance
    );
    setPositionedObjects(newPositioned);

    // Store positioned objects in Zustand for other controllers to access
    setStoreObjects(newPositioned);
  };

  // Generate initial positions when gameObjects change
  useEffect(() => {
    regeneratePositions();
  }, [gameObjects]);

  return (
    <>
      {positionedObjects.map((obj) => (
        <GameObjectCube key={obj.id} object={obj} />
      ))}
    </>
  );
}

interface GameObjectCubeProps {
  object: PositionedGameObject;
}

/**
 * Individual game object rendered as a cube
 */
function GameObjectCube({ object }: GameObjectCubeProps) {
  return (
    <mesh position={object.position}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#ffffff" roughness={0.3} metalness={0.7} />
    </mesh>
  );
}
