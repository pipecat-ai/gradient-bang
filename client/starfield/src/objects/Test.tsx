import { useCallback, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { useSceneObject } from "@/hooks/useSceneObject"
import type { SceneConfig } from "@/types"

export function TestObject() {
  const meshRef = useRef<THREE.Mesh>(null)

  const onApplyNewConfig = useCallback(async (config: SceneConfig) => {
    console.log("[TEST OBJECT] Applying new config", config)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    console.log("[TEST OBJECT] Config applied")
  }, [])

  const { sceneConfig, isSceneChanging } = useSceneObject(
    "test",
    onApplyNewConfig
  )

  // Memoize geometry and material with config
  /*const [geometry, material] = useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(2, 4)
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#FFFFFF"),
      emissive: new THREE.Color("#FFFFFF"),
      emissiveIntensity: 0.5,
      wireframe: true,
    })
    return [geo, mat]
  }, [])*/

  // Animation loop (pauses during transitions)
  useFrame((_state, delta) => {
    if (!isSceneChanging && meshRef.current) {
      //meshRef.current.rotation.x += delta * 0.1
      //meshRef.current.rotation.y += delta * 0.15
      //invalidate()
    }
  })

  return (
    <mesh ref={meshRef} position={[5, 0, 0]}>
      <boxGeometry />
      <meshBasicMaterial color={0xff0000} wireframe />
    </mesh>
  )
}
