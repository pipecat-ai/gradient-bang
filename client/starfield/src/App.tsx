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
  useGLTF,
} from "@react-three/drei"
import { Canvas } from "@react-three/fiber"
import { button, folder, Leva, useControls } from "leva"
import * as THREE from "three"

import { RenderMonitor } from "@/components/RenderMonitor"
import { AnimationController } from "@/controllers/AnimationController"
import { CameraController } from "@/controllers/Camera"
import { EnvironmentWrapper } from "@/controllers/Environment"
import { PostProcessing } from "@/controllers/PostProcessing"
import { SceneController } from "@/controllers/SceneController"
import { useSceneChange } from "@/hooks/useSceneChange"
import { TestObject } from "@/objects/Test"
import { TestPlanet } from "@/objects/TestPlanet"
import type { Scene, StarfieldConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

import { useAnimationStore } from "./useAnimationStore"

useGLTF.preload("/test-model.glb")

interface StarfieldProps {
  config?: Partial<StarfieldConfig>
  debug?: boolean
  scene?: Scene
  paused?: boolean
}

/**
 * Main application component
 */
export default function App({ config, debug = false }: StarfieldProps) {
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const isPaused = useGameStore((state) => state.isPaused)
  const togglePause = useGameStore((state) => state.togglePause)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const { changeScene } = useSceneChange()
  const { isWarping, startWarp, stopWarp, setWarpIntensity } =
    useAnimationStore()

  useLayoutEffect(() => {
    setStarfieldConfig(config ?? {})
  }, [config])

  const [, setSceneControls] = useControls("Scene Settings", () => ({
    ["Log Config"]: button(() => {
      console.log("Config", useGameStore.getState().starfieldConfig)
    }),
    ["Random Scene Change"]: button(() => {
      changeScene({
        id: Math.random().toString(36).substring(2, 15),
        gameObjects: [],
        config: {},
      })
    }),
    ["Scene 1 Change"]: button(() => {
      changeScene({
        id: "1",
        gameObjects: [],
        config: {},
      })
    }),
    ["Start Warp"]: button(() => {
      startWarp()
    }),
    ["Stop Warp"]: button(() => {
      stopWarp()
    }),
    warpIntensity: {
      value: 1,
      min: 1,
      max: 10,
      step: 1,
      label: "Warp Intensity",
      onEditEnd(value) {
        setWarpIntensity(value)
      },
    },
    warpStatus: {
      value: isWarping ? "Warping" : "Not Warping",
      editable: false,
    },
  }))

  useEffect(() => {
    setSceneControls({ warpStatus: isWarping ? "Warping" : "Not Warping" })
  }, [isWarping])

  const [{ dpr }, setPerformance] = useControls(() => ({
    "Render Settings": folder(
      {
        [isPaused ? "Resume" : "Pause"]: button(() => {
          togglePause()
        }),
        dpr: {
          value: 1.5,
          min: 1,
          max: 2,
          step: 0.1,
          label: "DPR",
        },
      },
      { collapsed: true }
    ),
  }))

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

        <SceneController />

        <AnimationController>
          <Suspense fallback={null}>
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
                <TestObject />

                {/*<GameObjects gameObjects={gameObjects} />
            <Stars ref={starsRef} />*/}
                <Center scale={modelScale}>
                  <Helmet />
                </Center>
              </Float>
            </group>
            <Grid cellColor={"#FFFFFF"} cellSize={1} infiniteGrid />
          </Suspense>

          <CameraController />
          <EnvironmentWrapper />
          <Effects />
        </AnimationController>
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
