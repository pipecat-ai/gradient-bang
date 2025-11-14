import { useFrame, useThree } from "@react-three/fiber";
import { folder, useControls } from "leva";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import * as THREE from "three";
import { useAsyncNoiseTexture } from "../hooks/useAsyncNoiseTexture";
import {
  nebulaFragmentShader,
  nebulaVertexShader,
} from "../shaders/NebulaShader";
import { NebulaConfig, WorldObject } from "../types";

/**
 * Ref type for Nebula component
 */
export type NebulaRef = WorldObject<NebulaConfig>;

/**
 * Nebula background effect component
 * Renders a procedurally generated nebula using custom shaders
 * All parameters controlled via Leva for live tweaking
 */
export const Nebula = forwardRef<NebulaRef, {}>((props, ref) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const { gl, camera } = useThree();
  const setRef = useRef<((config: Partial<NebulaConfig>) => void) | null>(null);

  // Leva controls for nebula parameters
  const [
    {
      enabled,
      noiseResolution,
      intensity,
      speed,
      primaryColor,
      secondaryColor,
      globalColor,
      domainScale,
      iterPrimary,
      iterSecondary,
      parallaxAmount,
    },
    set,
  ] = useControls(() => ({
    "Nebula Settings": folder({
      enabled: {
        value: true,
        label: "Enable Nebula",
      },
      noiseResolution: {
        value: 512,
        options: {
          "Low (128)": 128,
          "Medium (256)": 256,
          "High (512)": 512,
        },
        label: "Noise Quality",
      },
      intensity: {
        value: 0.6,
        min: 0,
        max: 5,
        step: 0.1,
        label: "Intensity",
      },
      speed: {
        value: 0, //0.005,
        min: 0,
        max: 1,
        step: 0.001,
        label: "Animation Speed",
      },
      primaryColor: {
        value: "#ff6b9d",
        label: "Primary Color",
      },
      secondaryColor: {
        value: "#c94b7d",
        label: "Secondary Color",
      },
      globalColor: {
        value: "#ffffff",
        label: "Global Tint",
      },
      domainScale: {
        value: 1.0,
        min: 0.1,
        max: 3,
        step: 0.1,
        label: "Domain Scale",
      },
      iterPrimary: {
        value: 6,
        min: 1,
        max: 10,
        step: 1,
        label: "Primary Iterations",
      },
      iterSecondary: {
        value: 4,
        min: 1,
        max: 10,
        step: 1,
        label: "Secondary Iterations",
      },
      parallaxAmount: {
        value: 0.5,
        min: 0,
        max: 2,
        step: 0.1,
        label: "Parallax Amount",
      },
    }),
  }));

  // Store the set function in a ref so loadConfig can use it
  useEffect(() => {
    setRef.current = set;
  }, [set]);

  // Load noise texture asynchronously (will suspend on first load)
  const noiseTexture = useAsyncNoiseTexture(noiseResolution);

  // Expose loadConfig method via ref
  useImperativeHandle(
    ref,
    () => ({
      loadConfig: async (config: Partial<NebulaConfig>) => {
        console.log("[Nebula] Loading new config:", config);

        // Track if noise resolution changed (requires async texture regeneration)
        const resolutionChanged =
          config.noiseResolution !== undefined &&
          config.noiseResolution !== noiseResolution;

        // Update Leva controls with new values
        if (setRef.current) {
          setRef.current(config);
        }

        // If resolution changed, we need to wait for the texture to regenerate
        // This happens automatically via useAsyncNoiseTexture hook on next render
        if (resolutionChanged) {
          // Wait a frame for the hook to trigger and texture to update
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Wait a frame for uniforms to update via useEffect
        await new Promise((resolve) => setTimeout(resolve, 0));

        console.log("[Nebula] Config loaded successfully");
      },
    }),
    [noiseResolution]
  );

  // Create shader material with all uniforms
  const material = useMemo(() => {
    const primaryColorObj = new THREE.Color(primaryColor);
    const secondaryColorObj = new THREE.Color(secondaryColor);
    const globalColorObj = new THREE.Color(globalColor);

    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        shakePhase: { value: 0 },
        resolution: {
          value: new THREE.Vector2(gl.domElement.width, gl.domElement.height),
        },
        cameraRotation: { value: new THREE.Vector3(0, 0, 0) },
        parallaxAmount: { value: parallaxAmount },
        intensity: { value: intensity },
        color: {
          value: new THREE.Vector3(
            globalColorObj.r,
            globalColorObj.g,
            globalColorObj.b
          ),
        },
        nebulaColorPrimary: {
          value: new THREE.Vector3(
            primaryColorObj.r,
            primaryColorObj.g,
            primaryColorObj.b
          ),
        },
        nebulaColorSecondary: {
          value: new THREE.Vector3(
            secondaryColorObj.r,
            secondaryColorObj.g,
            secondaryColorObj.b
          ),
        },
        speed: { value: speed },
        iterPrimary: { value: iterPrimary },
        iterSecondary: { value: iterSecondary },
        domainScale: { value: domainScale },
        shakeWarpIntensity: { value: 0 }, // Simplified - no shake for now
        shakeWarpRampTime: { value: 1 },
        nebulaShakeProgress: { value: 0 },
        noiseTexture: { value: noiseTexture },
        noiseUse: { value: 1.0 },
        shadowCenter: { value: new THREE.Vector2(0.5, 0.5) },
        shadowRadius: { value: 0 }, // Simplified - no shadow for now
        shadowSoftness: { value: 0 },
        shadowStrength: { value: 0 },
        noiseReduction: { value: 0.05 },
      },
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }, [noiseTexture, gl]);

  // Update uniforms when controls change
  useEffect(() => {
    if (!meshRef.current) return;
    const mat = meshRef.current.material as THREE.ShaderMaterial;

    mat.uniforms.intensity.value = intensity;
    mat.uniforms.speed.value = speed;
    mat.uniforms.domainScale.value = domainScale;
    mat.uniforms.iterPrimary.value = iterPrimary;
    mat.uniforms.iterSecondary.value = iterSecondary;
    mat.uniforms.parallaxAmount.value = parallaxAmount;

    const primaryColorObj = new THREE.Color(primaryColor);
    mat.uniforms.nebulaColorPrimary.value.set(
      primaryColorObj.r,
      primaryColorObj.g,
      primaryColorObj.b
    );

    const secondaryColorObj = new THREE.Color(secondaryColor);
    mat.uniforms.nebulaColorSecondary.value.set(
      secondaryColorObj.r,
      secondaryColorObj.g,
      secondaryColorObj.b
    );

    const globalColorObj = new THREE.Color(globalColor);
    mat.uniforms.color.value.set(
      globalColorObj.r,
      globalColorObj.g,
      globalColorObj.b
    );
  }, [
    intensity,
    speed,
    primaryColor,
    secondaryColor,
    globalColor,
    domainScale,
    iterPrimary,
    iterSecondary,
    parallaxAmount,
  ]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (!meshRef.current) return;
      const mat = meshRef.current.material as THREE.ShaderMaterial;
      mat.uniforms.resolution.value.set(
        gl.domElement.width,
        gl.domElement.height
      );
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [gl]);

  // Animate time uniform and update camera rotation for parallax
  useFrame((state) => {
    if (!meshRef.current) return;
    const mat = meshRef.current.material as THREE.ShaderMaterial;

    // Only update time if speed > 0 AND we're in continuous rendering mode
    // This prevents animation in demand mode (when nothing is happening)
    if (speed > 0) {
      // && isContinuous()) {
      mat.uniforms.time.value = state.clock.elapsedTime;
    }

    // Always update camera rotation for parallax when camera moves
    mat.uniforms.cameraRotation.value.set(
      camera.rotation.x,
      camera.rotation.y,
      camera.rotation.z
    );
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      material.dispose();
      // Note: noiseTexture is cached and managed by useAsyncNoiseTexture
      // so we don't dispose it here
    };
  }, [material]);

  if (!enabled) return null;

  return (
    <mesh
      ref={meshRef}
      material={material}
      frustumCulled={false}
      renderOrder={-999}
    >
      <planeGeometry args={[2, 2]} />
    </mesh>
  );
});
