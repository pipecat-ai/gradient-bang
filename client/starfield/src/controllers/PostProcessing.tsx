import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { BloomEffect, EffectComposer, EffectPass, RenderPass } from "postprocessing";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";

import { DitheringEffect } from "../fx/DitherEffect";

/**
 * Component that manages all post-processing effects
 * Configures and applies various effects to the rendered scene
 */
export const PostProcessing = () => {
  // References
  const composerRef = useRef<EffectComposer | null>(null);

  const [scene, setScene] = useState<THREE.Scene | null>(null);
  const [camera, setCamera] = useState<THREE.Camera | null>(null);

  // Effect controls
  const { bloom1Enabled, bloom1Threshold, bloom1Intensity, bloom1Radius } = useControls(
    {
      "Bloom 1": folder({
        bloom1Enabled: { value: false, label: "Enable Bloom 1 (Pre-Dithering)" },
        bloom1Threshold: { value: 0.0, min: 0, max: 2, step: 0.01, label: "Threshold" },
        bloom1Intensity: { value: 2.0, min: 0, max: 50, step: 0.1, label: "Intensity" },
        bloom1Radius: { value: 0.6, min: 0, max: 1, step: 0.1, label: "Radius" }
      })
    },
    { collapsed: true }
  );

  const { ditheringGridSize, pixelSizeRatio, grayscaleOnly } = useControls(
    {
      Dithering: folder({
        ditheringGridSize: { value: 4, min: 1, max: 20, step: 1, label: "Effect Resolution" },
        pixelSizeRatio: { value: 1, min: 1, max: 10, step: 1, label: "Pixelation Strength" },
        grayscaleOnly: { value: false, label: "Grayscale Only" }
      })
    },
    { collapsed: true }
  );

  // Memoized resize handler
  const handleResize = useCallback(() => {
    if (composerRef.current) {
      composerRef.current.setSize(window.innerWidth, window.innerHeight);
    }
  }, []);

  // Handle window resize
  useEffect(() => {
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [handleResize]);

  // Configure post-processing effects
  useEffect(() => {
    if (!scene || !camera || !composerRef.current) return;

    const composer = composerRef.current;
    composer.removeAllPasses();

    // Add required passes in order
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    if (bloom1Enabled) {
      composer.addPass(
        new EffectPass(
          camera,
          new BloomEffect({
            luminanceThreshold: bloom1Threshold,
            intensity: bloom1Intensity,
            radius: bloom1Radius,
            mipmapBlur: true
          })
        )
      );
    }

    // Dithering effect - always active
    composer.addPass(
      new EffectPass(
        camera,
        new DitheringEffect({
          gridSize: ditheringGridSize,
          pixelSizeRatio,
          grayscaleOnly
        })
      )
    );
  }, [scene, camera, bloom1Enabled, bloom1Threshold, bloom1Intensity, bloom1Radius, ditheringGridSize, pixelSizeRatio, grayscaleOnly]);

  // Handle rendering
  useFrame(({ gl, scene: currentScene, camera: currentCamera }) => {
    // Initialize composer if not yet created
    if (!composerRef.current) {
      composerRef.current = new EffectComposer(gl);
      handleResize(); // Initial sizing
    }

    // Update scene and camera references if changed
    if (scene !== currentScene) setScene(currentScene);
    if (camera !== currentCamera) setCamera(currentCamera);

    // Render the composer if available
    composerRef.current?.render();
  }, 1);

  return null;
};
