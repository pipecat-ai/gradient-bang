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
} from "three"

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
}

class StarfieldMaterial extends ShaderMaterial {
  constructor() {
    super({
      uniforms: {
        time: { value: 0.0 },
        fade: { value: 1.0 },
        fogColor: { value: new Color(0x000000) },
        fogNear: { value: 1 },
        fogFar: { value: 1000 },
      },
      vertexShader: /* glsl */ `
      uniform float time;
      attribute float size;
      varying vec3 vColor;
      
      #ifdef USE_FOG
        varying float vFogDepth;
      #endif
      
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 0.5);
        gl_PointSize = size * (30.0 / -mvPosition.z) * (3.0 + sin(time + 100.0));
        gl_Position = projectionMatrix * mvPosition;
        
        #include <fog_vertex>
      }`,
      fragmentShader: /* glsl */ `
      uniform sampler2D pointTexture;
      uniform float fade;
      varying vec3 vColor;
      
      #include <fog_pars_fragment>
      
      void main() {
        float opacity = 1.0;
        if (fade == 1.0) {
          float d = distance(gl_PointCoord, vec2(0.5, 0.5));
          opacity = 1.0 / (1.0 + exp(16.0 * (d - 0.25)));
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

const genStar = (r: number) => {
  return new Vector3().setFromSpherical(
    new Spherical(
      r,
      Math.acos(1 - Math.random() * 2),
      Math.random() * 2 * Math.PI
    )
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
    },
    ref
  ) => {
    const material = React.useRef<StarfieldMaterial>(null)
    const pointsRef = React.useRef<Points>(null)

    const [position, color, sizeAttr] = React.useMemo(() => {
      const positions: any[] = []
      const colors: any[] = []

      // If size is provided, use it directly; otherwise use factor-based calculation
      const sizes = Array.from({ length: count }, () =>
        size !== undefined ? size : (0.5 + 0.5 * Math.random()) * factor
      )
      const color = new Color()
      let r = radius + depth
      const increment = depth / count
      for (let i = 0; i < count; i++) {
        r -= increment * Math.random()
        positions.push(...genStar(r).toArray())
        color.setHSL(i / count, saturation, 0.9)
        colors.push(color.r, color.g, color.b)
      }
      return [
        new Float32Array(positions),
        new Float32Array(colors),
        new Float32Array(sizes),
      ]
    }, [count, depth, factor, radius, saturation, size])

    useFrame((state) => {
      if (!material.current) return

      // Update time uniform
      material.current.uniforms.time.value = state.clock.elapsedTime * speed

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
        </bufferGeometry>
        <primitive
          ref={material}
          object={starfieldMaterial}
          attach="material"
          blending={AdditiveBlending}
          uniforms-fade-value={fade}
          depthTest={true}
          depthWrite={true}
          transparent
          vertexColors
        />
      </points>
    )
  }
)
