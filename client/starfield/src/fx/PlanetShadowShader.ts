export const shadowVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const shadowFragmentShader = `
  uniform float uRadius;
  uniform float uOpacity;
  uniform float uFalloff;
  varying vec2 vUv;
  
  void main() {
    vec2 center = vec2(0.5, 0.5);
    float dist = distance(vUv, center) * 2.0; // Normalize to 0-1 range
    
    // Radius controls shadow size, falloff controls edge softness
    // Falloff of 0 = hard edge, higher = softer gradient
    float alpha = 1.0 - smoothstep(uRadius - uFalloff, uRadius, dist);
    alpha *= uOpacity;
    
    gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
  }
`
