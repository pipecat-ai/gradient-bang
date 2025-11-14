import { useTexture } from "@react-three/drei";
import { folder, useControls } from "leva";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { SkyboxConfig, WorldObject } from "../types";

/**
 * Ref type for Skybox component
 */
export type SkyboxRef = WorldObject<SkyboxConfig>;

/**
 * Skybox component that renders image sprites at far distances
 * Images are positioned randomly and can be configured via Leva
 */
export const Skybox = forwardRef<SkyboxRef, {}>((props, ref) => {
  const setRef = useRef<((config: Partial<SkyboxConfig>) => void) | null>(null);

  // Leva controls for skybox parameters
  const [
    {
      enabled,
      imageUrl,
      count,
      distance,
      minScale,
      maxScale,
      horizontalSpread,
      verticalSpread,
    },
    set,
  ] = useControls(() => ({
    Skybox: folder(
      {
        enabled: {
          value: true,
          label: "Enable Skybox",
        },
        imageUrl: {
          value: "/images/skybox-1.png",
          options: {
            "Skybox 1": "/images/skybox-1.png",
            "Skybox 2": "/images/skybox-2.png",
            "Skybox 3": "/images/skybox-3.png",
            "Skybox 4": "/images/skybox-4.png",
            "Skybox 5": "/images/skybox-5.png",
            "Skybox 6": "/images/skybox-6.png",
            "Skybox 7": "/images/skybox-7.png",
            "Skybox 8": "/images/skybox-8.png",
            "Skybox 9": "/images/skybox-9.png",
            "Splash 1": "/images/splash-1.png",
          },
          label: "Image",
        },
        count: {
          value: 3,
          min: 1,
          max: 10,
          step: 1,
          label: "Image Count",
        },
        distance: {
          value: 100,
          min: 50,
          max: 300,
          step: 10,
          label: "Distance from Camera",
        },
        minScale: {
          value: 5,
          min: 1,
          max: 20,
          step: 0.5,
          label: "Min Scale",
        },
        maxScale: {
          value: 10,
          min: 2,
          max: 30,
          step: 0.5,
          label: "Max Scale",
        },
        horizontalSpread: {
          value: 100,
          min: 20,
          max: 300,
          step: 10,
          label: "Horizontal Spread",
        },
        verticalSpread: {
          value: 80,
          min: 20,
          max: 200,
          step: 10,
          label: "Vertical Spread",
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
  useImperativeHandle(
    ref,
    () => ({
      loadConfig: async (config: Partial<SkyboxConfig>) => {
        console.log("[Skybox] Loading new config:", config);

        // Update Leva controls with new values
        if (setRef.current) {
          setRef.current(config);
        }

        // Wait for texture loading and updates
        await new Promise((resolve) => setTimeout(resolve, 100));

        console.log("[Skybox] Config loaded successfully");
      },
    }),
    []
  );

  // Load texture (wrapped in Suspense-safe way)
  const texture = useTexture(imageUrl);

  // Generate random positions for sprites (regenerates when count, spread, or distance changes)
  const positions = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        x: (Math.random() - 0.5) * horizontalSpread,
        y: (Math.random() - 0.5) * verticalSpread,
        z: -distance,
        scale: Math.random() * (maxScale - minScale) + minScale,
      })),
    [count, horizontalSpread, verticalSpread, distance, minScale, maxScale]
  );

  if (!enabled) return null;

  return (
    <group>
      {positions.map((pos, i) => (
        <sprite
          key={i}
          position={[pos.x, pos.y, pos.z]}
          scale={[pos.scale, pos.scale, 1]}
          renderOrder={-998} // Render after nebula but before everything else
        >
          <spriteMaterial
            attach="material"
            map={texture}
            transparent={true}
            depthTest={true}
            depthWrite={false}
            opacity={1}
            sizeAttenuation={false}
            toneMapped={false}
          />
        </sprite>
      ))}
    </group>
  );
});
