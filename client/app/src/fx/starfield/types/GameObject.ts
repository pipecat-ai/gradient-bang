import * as THREE from "three";
import { type RGBColor } from "./color";

// ============================================================================
// GAME OBJECT TYPE DEFINITIONS
// ============================================================================

/** Geometry types for game objects */
export type GeometryType = "box" | "octahedron" | "sphere";

/** Game object type definition */
export interface GameObjectTypeConfig {
  rotationSpeed: number;
  scale: number;
  color: RGBColor;
  geometry: GeometryType;
}

/** Game object types configuration - using Record with string keys */
export type GameObjectTypes = Record<string, GameObjectTypeConfig>;

export interface GameObjectBaseConfig {
  id: string;
  type: string;
  name?: string;
  position?: { x: number; y: number; z: number };
  metadata?: Record<string, unknown>;
}

export interface GameObjectConfig extends GameObjectBaseConfig {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: number;
}

/** Complete game object instance with Three.js data */
export interface GameObjectInstance {
  id: string;
  type: string;
  name: string;
  mesh: THREE.Mesh;
  originalMaterial: THREE.MeshBasicMaterial;
  rotationSpeed: number;
  metadata: {
    name: string;
    lastSeen: number;
    [key: string]: unknown;
  };
  isSelected?: boolean;
}

/** Object type configuration with Three.js geometry */
export interface ObjectTypeData {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  rotationSpeed: number;
  scale: number;
}

/** Selection result interface */
export interface SelectionResult {
  success: boolean;
  object?: GameObjectInstance;
  previousSelection?: GameObjectInstance;
}

/** Game object statistics */
export interface GameObjectStats {
  totalObjects: number;
  selectedObjects: number;
  objectsByType: {
    [type: string]: number;
  };
  visibleObjects: number;
}

/** Game object spawn rules */
export interface GameObjectSpawnRules {
  spawnRange: { x: number; y: number; z: number };
  minDistance: number;
  maxDistance: number;
}
