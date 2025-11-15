import { Center, Float, PerformanceMonitor, useGLTF } from "@react-three/drei"
import { Canvas } from "@react-three/fiber"
import { button, folder, Leva, useControls } from "leva"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { CameraController } from "@/controllers/Camera"
import { EnvironmentWrapper } from "@/controllers/Environment"
import { PostProcessing } from "@/controllers/PostProcessing"
import { useGameStore } from "@/useGameStore"
import { TestObject } from "@/objects/Test"
import { useSceneChange } from "@/hooks/useSceneChange"
import { SceneController } from "@/controllers/SceneController"
import type { GameObject, SceneConfig } from "@/types"
import { RenderMonitor } from "./components/RenderMonitor"

useGLTF.preload("/test-model.glb")

interface StarfieldProps {
  debug?: boolean
  gameObjects?: GameObject[]
  onReady?: () => void
  paused?: boolean
  sceneConfig?: SceneConfig
}

/**
 * Main application component
 */
export default function App({ debug = false, sceneConfig }: StarfieldProps) {
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const { changeScene } = useSceneChange()

  useControls("Scene Settings", () => ({
    "Scene Settings": folder({
      sceneChange: button(() => {
        changeScene({})
      }),
    }),
  }))

  const isPaused = useGameStore((state) => state.isPaused)
  const togglePause = useGameStore((state) => state.togglePause)

  const [{ cameraFloatingEnabled }] = useControls(() => ({
    "Render Settings": folder(
      {
        [isPaused ? "Resume" : "Pause"]: button(() => {
          togglePause()
        }),
      },
      { collapsed: true }
    ),
    "Scene Settings": folder(
      {
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
  }))

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
  )

  const [modelScale, setModelScale] = useState(3)

  // Responsive adjustment handler for model scale
  const handleResize = useCallback(() => {
    const isSmallScreen = window.innerWidth <= 768
    setModelScale(isSmallScreen ? 2.4 : 3)
  }, [])

  // Set up resize handling
  useEffect(() => {
    handleResize()

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [handleResize])

  console.debug("isPaused", isPaused)

  return (
    <>
      <Leva collapsed hidden={debug} />

      <Canvas
        frameloop={isPaused ? "never" : "demand"}
        dpr={dpr}
        shadows
        gl={{
          alpha: false,
          antialias: false,
          depth: true,
        }}
        onCreated={({ gl }) => {
          rendererRef.current = gl
          //gl.setClearColor(new THREE.Color("#000000"))
        }}
      >
        <PerformanceMonitor
          onIncline={() => setPerformance({ dpr: 2 })}
          onDecline={() => setPerformance({ dpr: 1 })}
        />
        <RenderMonitor />

        <CameraController />
        <SceneController initialConfig={sceneConfig ?? {}} />

        <TestObject />

        {/* Nebula background - rendered first and positioned at the back */}
        <group position={[0, 0, -50]}>{/* <Nebula ref={nebulaRef} /> */}</group>

        <group position={[0, 0, 0]}>
          <Float
            enabled={cameraFloatingEnabled}
            floatIntensity={0.5}
            rotationIntensity={0.5}
            speed={0.25}
            autoInvalidate
          >
            {/* Scene Elements */}
            {/*<GameObjects gameObjects={gameObjects} />
            <Stars ref={starsRef} />*/}
            <Center scale={modelScale}>
              <Helmet />
            </Center>
          </Float>
        </group>

        <EnvironmentWrapper />
        <Effects />
      </Canvas>
    </>
  )
}

/**
 * Post-processing effects wrapper component
 * Memoized to prevent unnecessary re-renders
 */
const Effects = memo(() => <PostProcessing />)

interface HelmetProps {
  [key: string]: any
}

/**
 * 3D Helmet model component
 */
function Helmet(props: HelmetProps) {
  const { nodes, materials } = useGLTF("/test-model.glb") as any
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
