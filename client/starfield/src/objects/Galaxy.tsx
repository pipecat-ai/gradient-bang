import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"
import { useShallow } from "zustand/react/shallow"

import { getPalette } from "@/colors"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import {
  galaxyBakeFragmentShader,
  galaxyBakeVertexShader,
  galaxyDisplayFragmentShader,
  galaxyDisplayVertexShader,
} from "@/shaders/GalaxyShader"
import { useGameStore } from "@/useGameStore"

// Render target resolution for the baked galaxy texture
const GALAXY_TEXTURE_WIDTH = 2048
const GALAXY_TEXTURE_HEIGHT = 1024

const DEFAULT_GALAXY_CONFIG = {
  enabled: true,
  intensity: 1,
  spread: 0.8,
  rotation: 0,
  offsetX: 0.2,
  offsetY: 0,
  octaves: 5,
  primaryColor: "#000000",
  secondaryColor: "#000000",
}

const TRANSIENT_PROPERTIES = [
  "enabled",
  "intensity",
  "spread",
  "rotation",
  "offsetX",
  "offsetY",
  "octaves",
] as const

export const Galaxy = () => {
  const showControls = useShowControls()
  const { gl } = useThree()
  const { galaxyConfig, paletteKey } = useGameStore(
    useShallow((state) => ({
      galaxyConfig: state.starfieldConfig.galaxy,
      paletteKey: state.starfieldConfig.palette,
    }))
  )

  const bakeMaterialRef = useRef<THREE.ShaderMaterial | null>(null)
  const needsRenderRef = useRef(true)
  const prevControlsRef = useRef({
    intensity: -1,
    spread: -1,
    rotation: -999,
    offsetX: -999,
    offsetY: -999,
    octaves: -1,
    primaryColor: "",
    secondaryColor: "",
  })

  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])

  // Leva controls
  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            Objects: folder(
              {
                Galaxy: folder(
                  {
                    enabled: {
                      value:
                        galaxyConfig?.enabled ?? DEFAULT_GALAXY_CONFIG.enabled,
                      label: "Enable Galaxy",
                    },
                    intensity: {
                      value:
                        galaxyConfig?.intensity ??
                        DEFAULT_GALAXY_CONFIG.intensity,
                      min: 0,
                      max: 5,
                      step: 0.1,
                      label: "Intensity",
                    },
                    spread: {
                      value:
                        galaxyConfig?.spread ?? DEFAULT_GALAXY_CONFIG.spread,
                      min: 0.1,
                      max: 5,
                      step: 0.1,
                      label: "Spread",
                    },
                    rotation: {
                      value:
                        galaxyConfig?.rotation ??
                        DEFAULT_GALAXY_CONFIG.rotation,
                      min: -3.14,
                      max: 3.14,
                      step: 0.01,
                      label: "Rotation",
                    },
                    offsetX: {
                      value:
                        galaxyConfig?.offsetX ?? DEFAULT_GALAXY_CONFIG.offsetX,
                      min: -1,
                      max: 1,
                      step: 0.01,
                      label: "Offset X",
                    },
                    offsetY: {
                      value:
                        galaxyConfig?.offsetY ?? DEFAULT_GALAXY_CONFIG.offsetY,
                      min: -0.8,
                      max: 0.8,
                      step: 0.01,
                      label: "Offset Y",
                    },
                    octaves: {
                      value:
                        galaxyConfig?.octaves ?? DEFAULT_GALAXY_CONFIG.octaves,
                      min: 1,
                      max: 5,
                      step: 1,
                      label: "Noise Octaves",
                    },
                    primaryColor: {
                      value: `#${palette.c1.getHexString()}`,
                      label: "Primary Color",
                    },
                    secondaryColor: {
                      value: `#${palette.c2.getHexString()}`,
                      label: "Secondary Color",
                    },
                  },
                  { collapsed: true }
                ),
              },
              { collapsed: true, order: PANEL_ORDERING.RENDERING }
            ),
          }
        : {}) as Schema
  )

  const controls = useControlSync({
    source: galaxyConfig as Partial<typeof DEFAULT_GALAXY_CONFIG> | undefined,
    defaults: DEFAULT_GALAXY_CONFIG,
    palette,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<typeof DEFAULT_GALAXY_CONFIG>,
    set: set as (values: Partial<typeof DEFAULT_GALAXY_CONFIG>) => void,
  })

  // Render target for baked galaxy texture
  const renderTarget = useMemo(() => {
    return new THREE.WebGLRenderTarget(
      GALAXY_TEXTURE_WIDTH,
      GALAXY_TEXTURE_HEIGHT,
      {
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      }
    )
  }, [])

  // Offscreen scene for baking
  const { offscreenScene, offscreenCamera, bakeMaterial } = useMemo(() => {
    const scene = new THREE.Scene()
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    cam.position.z = 1

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uIntensity: { value: 1.0 },
        uSpread: { value: 1.0 },
        uColor1: { value: new THREE.Vector3(1, 1, 1) },
        uColor2: { value: new THREE.Vector3(1, 1, 1) },
        uGalaxyCenter: { value: new THREE.Vector3(0, 0, 1) },
        uGalaxyUp: { value: new THREE.Vector3(0, 1, 0) },
        uRotation: { value: 0 },
        uOctaves: { value: 5 },
      },
      vertexShader: galaxyBakeVertexShader,
      fragmentShader: galaxyBakeFragmentShader,
      depthTest: false,
      depthWrite: false,
    })

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    scene.add(quad)

    return {
      offscreenScene: scene,
      offscreenCamera: cam,
      bakeMaterial: material,
    }
  }, [])

  // Display material
  const displayMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: renderTarget.texture },
      },
      vertexShader: galaxyDisplayVertexShader,
      fragmentShader: galaxyDisplayFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    })
  }, [renderTarget.texture])

  // Store bake material ref
  useEffect(() => {
    bakeMaterialRef.current = bakeMaterial
  }, [bakeMaterial])

  // Cleanup
  useEffect(() => {
    return () => {
      renderTarget.dispose()
      bakeMaterial.dispose()
      displayMaterial.dispose()
    }
  }, [renderTarget, bakeMaterial, displayMaterial])

  // Re-bake texture only when controls change
  useFrame(() => {
    const material = bakeMaterialRef.current
    if (!material) return

    const prev = prevControlsRef.current
    const hasChanged =
      needsRenderRef.current ||
      Math.abs(prev.intensity - controls.intensity) > 0.001 ||
      Math.abs(prev.spread - controls.spread) > 0.001 ||
      Math.abs(prev.rotation - controls.rotation) > 0.001 ||
      Math.abs(prev.offsetX - controls.offsetX) > 0.001 ||
      Math.abs(prev.offsetY - controls.offsetY) > 0.001 ||
      prev.octaves !== controls.octaves ||
      prev.primaryColor !== controls.primaryColor ||
      prev.secondaryColor !== controls.secondaryColor

    if (!hasChanged) return

    // Update tracked values
    prev.intensity = controls.intensity
    prev.spread = controls.spread
    prev.rotation = controls.rotation
    prev.offsetX = controls.offsetX
    prev.offsetY = controls.offsetY
    prev.octaves = controls.octaves
    prev.primaryColor = controls.primaryColor
    prev.secondaryColor = controls.secondaryColor
    needsRenderRef.current = false

    // Compute galaxy center direction from offset
    // offsetX: -1 to +1 maps to horizontal rotation (-180° to +180°)
    // offsetY: -1 to +1 maps to vertical angle (-90° to +90°)
    const hAngle = -controls.offsetX * Math.PI
    const vAngle = controls.offsetY * Math.PI * 0.5

    const cosH = Math.cos(hAngle)
    const sinH = Math.sin(hAngle)
    const cosV = Math.cos(vAngle)
    const sinV = Math.sin(vAngle)

    // Start with forward (0,0,1), rotate around Y (horizontal), then around X (vertical)
    const cx = sinH * cosV
    const cy = sinV
    const cz = cosH * cosV

    // Update uniforms
    material.uniforms.uIntensity.value = controls.intensity
    material.uniforms.uSpread.value = controls.spread
    material.uniforms.uRotation.value = controls.rotation
    material.uniforms.uOctaves.value = controls.octaves
    material.uniforms.uGalaxyCenter.value.set(cx, cy, cz)
    material.uniforms.uGalaxyUp.value.set(0, 1, 0)

    const color1 = new THREE.Color(controls.primaryColor)
    const color2 = new THREE.Color(controls.secondaryColor)
    material.uniforms.uColor1.value.set(color1.r, color1.g, color1.b)
    material.uniforms.uColor2.value.set(color2.r, color2.g, color2.b)

    // Render to texture
    const currentTarget = gl.getRenderTarget()
    gl.setRenderTarget(renderTarget)
    gl.clear()
    gl.render(offscreenScene, offscreenCamera)
    gl.setRenderTarget(currentTarget)
  })

  // Only hide if explicitly disabled (not undefined during HMR settling)
  if (controls.enabled === false) return null

  return (
    <mesh
      renderOrder={-1000}
      layers={LAYERS.SKYBOX}
      material={displayMaterial}
      frustumCulled={false}
      rotation={[0, Math.PI, 0]}
    >
      <sphereGeometry args={[500, 32, 32]} />
    </mesh>
  )
}
