import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  Center,
  Float,
  Grid,
  PerformanceMonitor,
  Stats,
  useGLTF,
} from "@react-three/drei"
import { Canvas } from "@react-three/fiber"
import { Leva } from "leva"
import * as THREE from "three"

import { AnimationController } from "@/controllers/AnimationController"
import { CameraController } from "@/controllers/Camera"
import { EnvironmentWrapper } from "@/controllers/Environment"
import { SceneController } from "@/controllers/SceneController"
import { Dust } from "@/objects/Dust"
import { Stars } from "@/objects/Stars"
import type { PerformanceProfile, Scene, StarfieldConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

import { RenderingIndicator } from "./components/RenderingIndicator"
import { Effects } from "./controllers/Effects"
import { PostProcessing } from "./controllers/PostProcessing"
import { useDevControls } from "./hooks/useDevControls"
import { Fog } from "./objects/Fog"
import { Planet } from "./objects/Planet"

useGLTF.preload("/test-model.glb")

interface StarfieldProps {
  config?: Partial<StarfieldConfig>
  profile?: PerformanceProfile
  debug?: boolean
  scene?: Scene
  paused?: boolean
}

export const LAYERS = {
  DEFAULT: 0, // Main scene objects
  BACKGROUND: 1, // Stars
  SKYBOX: 2, // Skybox (Planet, Shadow)
  FOREGROUND: 3, // UI elements
  GAMEOBJECTS: 4, // GameObjects
  DEBUG: 31, // Grid, debug helpers
} as const

/**
 * Main application component
 */
export default function App({
  config,
  debug = false,
  profile = "high",
}: StarfieldProps) {
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const isPaused = useGameStore((state) => state.isPaused)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const setPerformanceProfile = useGameStore(
    (state) => state.setPerformanceProfile
  )
  const { dpr, setPerformance } = useDevControls()
  const [modelScale, setModelScale] = useState(3)

  useLayoutEffect(() => {
    setPerformanceProfile(profile)
  }, [profile, setPerformanceProfile])

  useLayoutEffect(() => {
    setStarfieldConfig(config ?? {})
  }, [config, setStarfieldConfig])

  // Responsive adjustment handler for model scale
  const handleResize = useCallback(() => {
    const isSmallScreen = window.innerWidth <= 768
    setModelScale(isSmallScreen ? 2.4 : 3)
  }, [])

  // Set up resize handling
  useEffect(() => {
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [handleResize])

  return (
    <>
      <Leva collapsed hidden={debug} />

      <Canvas
        frameloop={isPaused ? "never" : "demand"}
        dpr={dpr as number}
        shadows
        gl={{
          alpha: false,
          antialias: false,
          depth: true,
        }}
        onCreated={({ gl, camera }) => {
          rendererRef.current = gl
          gl.setClearColor(new THREE.Color("#000000"))

          // Enable various layers
          camera.layers.enable(LAYERS.DEFAULT)
          camera.layers.enable(LAYERS.BACKGROUND)
          camera.layers.enable(LAYERS.SKYBOX)
          camera.layers.enable(LAYERS.GAMEOBJECTS)
          if (debug) {
            camera.layers.enable(LAYERS.DEBUG)
          }
        }}
      >
        <PerformanceMonitor
          onIncline={() => setPerformance({ dpr: 2 })}
          onDecline={() => setPerformance({ dpr: 1 })}
        />
        <Stats showPanel={0} />
        <RenderingIndicator />
        <SceneController />

        <AnimationController>
          <Suspense fallback={null}>
            <Fog />
            <Stars />
            <Planet />

            {/* Nebula background - rendered first and positioned at the back */}
            <group position={[0, 0, -50]}>
              {/* <Nebula ref={nebulaRef} /> */}
            </group>

            <group position={[0, 0, 0]}>
              <Float
                enabled={false}
                floatIntensity={1}
                rotationIntensity={0.5}
                speed={3}
                autoInvalidate={false}
              >
                {/* Scene Elements */}
                <Dust />
                <Center scale={modelScale}>{<Helmet />}</Center>
              </Float>
            </group>
            <Grid cellColor={"#FFFFFF"} cellSize={1} infiniteGrid />
          </Suspense>

          <CameraController />

          <EnvironmentWrapper />
          <PostProcessingMemo />
          <Effects />
        </AnimationController>
      </Canvas>
    </>
  )
}

export const PostProcessingMemo = memo(PostProcessing)

interface HelmetProps {
  [key: string]: unknown
}

/**
 * 3D Helmet model component
 */
function Helmet(props: HelmetProps) {
  const { nodes, materials } = useGLTF("/test-model.glb") as unknown as {
    nodes: Record<string, THREE.Mesh>
    materials: Record<string, THREE.Material>
  }
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
  )
}
