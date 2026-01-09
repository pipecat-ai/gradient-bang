import * as React from "react"
import type { ForwardRefComponent } from "@react-three/drei/helpers/ts-utils"
import { useFrame, type ThreeElement } from "@react-three/fiber"
import {
  AdditiveBlending,
  Color,
  Points,
  ShaderMaterial,
  Spherical,
  Vector3,
  type Blending,
} from "three"

import { seededRandom } from "../utils/math"

export type StarsProps = {
  radius?: number
  depth?: number
  count?: number
  factor?: number
  saturation?: number
  fade?: boolean
  speed?: number
  layers?: number | number[]
  size?: number
  renderOrder?: number
  blending?: Blending
  opacityRange?: [number, number]
}

class StarfieldMaterial extends ShaderMaterial {
  constructor() {
    super({
      uniforms: {
        time: { value: 0.0 },
        fade: { value: 1.0 },
        dpr: { value: 1.0 },
        fogColor: { value: new Color(0x000000) },
        fogNear: { value: 1 },
        fogFar: { value: 1000 },
      },
      vertexShader: /* glsl */ `
      uniform float time;
      uniform float dpr;
      attribute float size;
      attribute float opacity;
      varying vec3 vColor;
      varying float vOpacity;
      
      #ifdef USE_FOG
        varying float vFogDepth;
      #endif
      
      void main() {
        vColor = color;
        vOpacity = opacity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 0.5);
        gl_PointSize = size * (30.0 / -mvPosition.z) * (3.0 + sin(time + 100.0)) * dpr;
        gl_Position = projectionMatrix * mvPosition;
        
        #include <fog_vertex>
      }`,
      fragmentShader: /* glsl */ `
      uniform sampler2D pointTexture;
      uniform float fade;
      varying vec3 vColor;
      varying float vOpacity;
      
      #include <fog_pars_fragment>
      
      void main() {
        float opacity = vOpacity;
        if (fade == 1.0) {
          float d = distance(gl_PointCoord, vec2(0.5, 0.5));
          opacity *= 1.0 / (1.0 + exp(16.0 * (d - 0.25)));
        }
        gl_FragColor = vec4(vColor, opacity);

        #include <tonemapping_fragment>
	      #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
      fog: true,
    })
  }
}

declare module "@react-three/fiber" {
  interface ThreeElements {
    starfieldMaterial: ThreeElement<typeof StarfieldMaterial>
  }
}

const genStar = (r: number, random: () => number) => {
  return new Vector3().setFromSpherical(
    new Spherical(r, Math.acos(1 - random() * 2), random() * 2 * Math.PI)
  )
}

export const Stars: ForwardRefComponent<StarsProps, Points> = React.forwardRef(
  (
    {
      radius = 100,
      depth = 50,
      count = 5000,
      saturation = 0,
      factor = 4,
      fade = false,
      speed = 1,
      layers,
      size,
      renderOrder = -100,
      blending = AdditiveBlending,
      opacityRange = [0.3, 1.0],
    },
    ref
  ) => {
    const material = React.useRef<StarfieldMaterial>(null)
    const pointsRef = React.useRef<Points>(null)

    const [position, color, sizeAttr, opacityAttr] = React.useMemo(() => {
      const positions: number[] = []
      const colors: number[] = []

      // Use seeded random for deterministic, pure generation
      const random = seededRandom(count + radius + depth)

      // If size is provided, use it directly; otherwise use factor-based calculation
      const sizes = Array.from({ length: count }, () =>
        size !== undefined ? size : (0.5 + 0.5 * random()) * factor
      )

      // Generate variable opacity for each star
      const opacities = Array.from(
        { length: count },
        () => opacityRange[0] + random() * (opacityRange[1] - opacityRange[0])
      )

      const color = new Color()
      let r = radius + depth
      const increment = depth / count
      for (let i = 0; i < count; i++) {
        r -= increment * random()
        positions.push(...genStar(r, random).toArray())
        color.setHSL(i / count, saturation, 0.9)
        colors.push(color.r, color.g, color.b)
      }
      return [
        new Float32Array(positions),
        new Float32Array(colors),
        new Float32Array(sizes),
        new Float32Array(opacities),
      ]
    }, [count, depth, factor, radius, saturation, size, opacityRange])

    useFrame((state) => {
      if (!material.current) return

      // Update time uniform
      material.current.uniforms.time.value = state.clock.elapsedTime * speed

      // Update DPR for consistent sizing across resolutions
      material.current.uniforms.dpr.value = state.viewport.dpr

      // Make stars follow camera position (skybox behavior)
      if (pointsRef.current) {
        pointsRef.current.position.copy(state.camera.position)
      }

      // Sync fog uniforms with scene fog
      if (state.scene.fog) {
        material.current.uniforms.fogColor.value.set(state.scene.fog.color)
        if ("near" in state.scene.fog) {
          material.current.uniforms.fogNear.value = state.scene.fog.near
          material.current.uniforms.fogFar.value = state.scene.fog.far
        }
      }
    })

    const [starfieldMaterial] = React.useState(() => new StarfieldMaterial())

    // Handle layers and render order
    React.useLayoutEffect(() => {
      if (pointsRef.current) {
        // Set layers
        if (layers !== undefined) {
          if (Array.isArray(layers)) {
            pointsRef.current.layers.disableAll()
            layers.forEach((layer) => pointsRef.current!.layers.enable(layer))
          } else {
            pointsRef.current.layers.set(layers)
          }
        }

        // Set render order
        pointsRef.current.renderOrder = renderOrder
      }
    }, [layers, renderOrder])

    // Merge refs
    React.useImperativeHandle(ref, () => pointsRef.current as Points, [])

    return (
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[position, 3]} />
          <bufferAttribute attach="attributes-color" args={[color, 3]} />
          <bufferAttribute attach="attributes-size" args={[sizeAttr, 1]} />
          <bufferAttribute
            attach="attributes-opacity"
            args={[opacityAttr, 1]}
          />
        </bufferGeometry>
        <primitive
          ref={material}
          object={starfieldMaterial}
          attach="material"
          blending={blending}
          uniforms-fade-value={fade}
          depthTest={true}
          depthWrite={false}
          transparent
          vertexColors
        />
      </points>
    )
  }
)
