import {
  Center,
  Float,
  PerformanceMonitor,
  useGLTF,
  useProgress,
} from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { button, folder, Leva, useControls } from "leva";
import {
  FC,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { CameraController } from "./controllers/Camera";
import { EnvironmentWrapper } from "./controllers/Environment";
import { GameObjects } from "./controllers/GameObjects";
import { PostProcessing } from "./controllers/PostProcessing";
import {
  SceneController,
  SceneControllerRef,
} from "./controllers/SceneController";
import { Nebula, NebulaRef } from "./objects/Nebula";
import { Stars, StarsRef } from "./objects/Stars";
import { useGameStore } from "./stores/useGameStore";
import { GameObject, SceneConfig } from "./types";

useGLTF.preload("/test-model.glb");

interface StarfieldProps {
  debug?: boolean;
  gameObjects?: GameObject[];
  onReady?: () => void;
  paused?: boolean;
  sceneConfig?: SceneConfig;
}

/**
 * Main application component
 */
export default function App({
  debug = false,
  gameObjects = [],
  onReady,
  paused = false,
}: StarfieldProps) {
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const nebulaRef = useRef<NebulaRef>(null);
  const starsRef = useRef<StarsRef>(null);
  const sceneControllerRef = useRef<SceneControllerRef>(null);

  const isPaused = useGameStore((state) => state.isPaused);
  const togglePause = useGameStore((state) => state.togglePause);

  const [{ bgColor, cameraFloatingEnabled }, setSceneSettings] = useControls(
    () => ({
      "Render Settings": folder(
        {
          [isPaused ? "Resume" : "Pause"]: button(() => {
            togglePause();
          }),
        },
        { collapsed: true }
      ),
      "Scene Settings": folder(
        {
          bgColor: {
            value: "#000000",
            label: "Background Color",
          },
          isShaking: {
            value: false,
            label: "Shake",
          },
          cameraFloatingEnabled: {
            value: false,
            label: "Camera Floating",
          },
        },
        { collapsed: true }
      ),
    })
  );

  const [{ dpr }, setPerformance] = useControls(
    "Performance Settings",
    () => ({
      dpr: {
        value: 1.5,
        min: 1,
        max: 2,
        step: 0.1,
        label: "DPR",
      },
    }),
    { collapsed: true }
  );

  const [modelScale, setModelScale] = useState(3);

  const { intensity, highlight } = useControls({
    "Environment Settings": folder(
      {
        intensity: {
          value: 1.5,
          min: 0,
          max: 5,
          step: 0.1,
          label: "Environment Intensity",
        },
        highlight: {
          value: "#066aff",
          label: "Highlight Color",
        },
      },
      { collapsed: true }
    ),
  });

  // Update renderer clear color when background color changes
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setClearColor(new THREE.Color(bgColor));
    }
  }, [bgColor]);

  // Responsive adjustment handler for model scale
  const handleResize = useCallback(() => {
    const isSmallScreen = window.innerWidth <= 768;
    setModelScale(isSmallScreen ? 2.4 : 3);
  }, []);

  // Set up resize handling
  useEffect(() => {
    handleResize();

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [handleResize]);

  console.log("isPaused", isPaused);
  return (
    <>
      <Leva collapsed hidden={debug} />
      <Canvas
        frameloop={isPaused ? "never" : "demand"}
        dpr={dpr}
        shadows
        camera={{ position: [0, -1, 4], fov: 65 }}
        gl={{
          alpha: false,
          antialias: false,
          depth: true,
        }}
        onCreated={({ gl }) => {
          rendererRef.current = gl;
          gl.setClearColor(new THREE.Color(bgColor));
        }}
      >
        <PerformanceMonitor
          onIncline={() => setPerformance({ dpr: 2 })}
          onDecline={() => setPerformance({ dpr: 1 })}
        />

        <CameraController />
        <SceneController
          ref={sceneControllerRef}
          nebulaRef={nebulaRef}
          starsRef={starsRef}
        />
        <LoadingTracker onReady={onReady} />

        {/* Wrap async components in Suspense - blocks rendering until ready */}
        <Suspense fallback={null}>
          {/* Nebula background - rendered first and positioned at the back */}
          <group position={[0, 0, -50]}>
            <Nebula ref={nebulaRef} />
          </group>

          <group position={[0, -0.5, 0]}>
            <Float
              enabled={cameraFloatingEnabled}
              floatIntensity={0.5}
              rotationIntensity={0.5}
              speed={0.25}
              autoInvalidate
            >
              <GameObjects gameObjects={gameObjects} />
              <Stars ref={starsRef} />
              <Center
                scale={modelScale}
                position={[0, 0.8, 0]}
                rotation={[0, -Math.PI / 3.5, -0.4]}
              >
                <Helmet />
              </Center>
            </Float>
          </group>
        </Suspense>

        <EnvironmentWrapper intensity={intensity} highlight={highlight} />
        <Effects />
      </Canvas>
    </>
  );
}

/**
 * Loading tracker component that fires onReady callback when loading is complete
 */
function LoadingTracker({ onReady }: { onReady?: () => void }) {
  const { active, progress } = useProgress();
  const hasCalledReady = useRef(false);

  useEffect(() => {
    // Fire callback when loading is complete and we haven't called it yet
    if (!active && progress === 100 && onReady && !hasCalledReady.current) {
      hasCalledReady.current = true;
      console.log("[STARFIELD] All assets loaded, scene ready");
      onReady();
    }
  }, [active, progress, onReady]);

  return null;
}

/**
 * Post-processing effects wrapper component
 * Memoized to prevent unnecessary re-renders
 */
const Effects: FC = memo(() => <PostProcessing />);

interface HelmetProps {
  [key: string]: any;
}

/**
 * 3D Helmet model component
 */
function Helmet(props: HelmetProps) {
  const { nodes, materials } = useGLTF("/test-model.glb") as any;
  return (
    <group {...props} dispose={null}>
      <mesh
        castShadow
        geometry={nodes.Object_2.geometry}
        material={materials.model_Material_u1_v1}
        material-roughness={0.15}
        position={[-2.016, -0.06, 1.381]}
        rotation={[-1.601, 0.068, 2.296]}
        scale={0.038}
      />
    </group>
  );
}
