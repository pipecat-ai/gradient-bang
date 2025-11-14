import { useThree } from "@react-three/fiber";
import { folder, useControls } from "leva";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import * as THREE from "three";
import { StarsConfig, WorldObject } from "../types";

/**
 * Ref type for Stars component
 */
export type StarsRef = WorldObject<StarsConfig>;

/**
 * Pixelated starfield component with spherical distribution
 * All parameters controlled via Leva for live tweaking
 */
export const Stars = forwardRef<StarsRef, {}>((props, ref) => {
  const pointsRef = useRef<THREE.Points>(null);
  const { scene } = useThree();
  const setRef = useRef<((config: Partial<StarsConfig>) => void) | null>(null);

  // Leva controls for starfield parameters
  const [
    { count, radius, size, color, fogEnabled, fogNear, fogFar, fogColor },
    set,
  ] = useControls(() => ({
    Starfield: folder(
      {
        count: {
          value: 5000,
          min: 1000,
          max: 10000,
          step: 100,
          label: "Star Count",
        },
        radius: {
          value: 100,
          min: 10,
          max: 200,
          step: 1,
          label: "Distribution Radius",
        },
        size: {
          value: 0.1,
          min: 0.1,
          max: 5,
          step: 0.05,
          label: "Star Size",
        },
        color: {
          value: "#ffffff",
          label: "Star Color",
        },
        fogEnabled: {
          value: true,
          label: "Enable Fog",
        },
        fogNear: {
          value: 10,
          min: 1,
          max: 50,
          step: 1,
          label: "Fog Near",
        },
        fogFar: {
          value: 80,
          min: 20,
          max: 150,
          step: 1,
          label: "Fog Far",
        },
        fogColor: {
          value: "#000000",
          label: "Fog Color",
        },
      },
      { collapsed: true }
    ),
  }));

  // Store the set function in a ref so loadConfig can use it
  useEffect(() => {
    setRef.current = set;
  }, [set]);

  // Expose loadConfig method via ref
  useImperativeHandle(ref, () => ({
    loadConfig: async (config: Partial<StarsConfig>) => {
      console.log("[Stars] Loading new config:", config);

      // Update Leva controls with new values
      if (setRef.current) {
        setRef.current(config);
      }

      // Wait for geometry and material updates to complete via useEffect
      await new Promise((resolve) => setTimeout(resolve, 0));

      console.log("[Stars] Config loaded successfully");
    },
  }));

  // Generate star positions in spherical distribution
  const positions = useMemo(() => {
    const positionsArray = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      // Generate random spherical coordinates
      // Use cube root for uniform volume distribution (avoids center clustering)
      const r = Math.cbrt(Math.random()) * radius;
      const theta = Math.random() * Math.PI * 2; // Azimuthal angle (0 to 2π)
      const phi = Math.acos(2 * Math.random() - 1); // Polar angle (0 to π) with uniform distribution

      // Convert spherical to Cartesian coordinates
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);

      positionsArray[i * 3] = x;
      positionsArray[i * 3 + 1] = y;
      positionsArray[i * 3 + 2] = z;
    }

    return positionsArray;
  }, [count, radius]);

  // Update geometry positions when count or radius changes
  useEffect(() => {
    if (pointsRef.current) {
      const geometry = pointsRef.current.geometry;
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3)
      );
      geometry.attributes.position.needsUpdate = true;
      geometry.computeBoundingSphere();
    }
  }, [positions]);

  // Update material properties when color or size changes
  useEffect(() => {
    if (pointsRef.current) {
      const material = pointsRef.current.material as THREE.PointsMaterial;
      material.color.set(color);
      material.size = size;
      material.needsUpdate = true;
    }
  }, [color, size]);

  // Handle fog settings
  useEffect(() => {
    if (fogEnabled) {
      scene.fog = new THREE.Fog(fogColor, fogNear, fogFar);
    } else {
      scene.fog = null;
    }

    // Cleanup on unmount
    return () => {
      scene.fog = null;
    };
  }, [scene, fogEnabled, fogNear, fogFar, fogColor]);

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={size}
        color={color}
        sizeAttenuation={true}
        transparent={false}
        depthWrite={true}
        depthTest={true}
        fog={true}
      />
    </points>
  );
});
