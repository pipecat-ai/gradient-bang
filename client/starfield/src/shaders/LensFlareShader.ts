export const lensFlareVertexShader = `
  varying vec2 vUv;
  
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

export const lensFlareFragmentShader = `
  precision highp float;
  
  uniform vec2 uResolution;
  uniform vec2 uLightPosition;
  uniform float uIntensity;
  uniform vec3 uColor;
  uniform float uGhostIntensity;
  uniform float uHaloIntensity;
  uniform float uStreakIntensity;
  uniform int uQuality; // 0 = low, 1 = medium, 2 = high
  
  varying vec2 vUv;
  
  // Fast approximation for length using inversesqrt
  float fastLength(vec2 v) {
    float d2 = dot(v, v);
    return d2 * inversesqrt(d2 + 0.0001); // Add small epsilon to avoid div by zero
  }
  
  // Hash for dithering
  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  
  vec3 lensflare(vec2 uv, vec2 pos) {
    vec2 uvd = uv * fastLength(uv);
    
    // Early-out: skip calculations if too far from any effect region
    float maxDist = fastLength(uv - pos);
    float maxGhostDist = fastLength(uv + pos); // Ghosts appear opposite
    if (maxDist > 2.0 && maxGhostDist > 2.0) {
      return vec3(0.0);
    }
    
    vec3 c = vec3(0.0);
    
    // Halo rings with chromatic aberration (always rendered - cheap)
    float f2 = max(1.0 / (1.0 + 32.0 * dot(uvd + 0.8 * pos, uvd + 0.8 * pos)), 0.0) * 0.5 * uHaloIntensity;
    float f22 = max(1.0 / (1.0 + 32.0 * dot(uvd + 0.85 * pos, uvd + 0.85 * pos)), 0.0) * 0.46 * uHaloIntensity;
    float f23 = max(1.0 / (1.0 + 32.0 * dot(uvd + 0.9 * pos, uvd + 0.9 * pos)), 0.0) * 0.42 * uHaloIntensity;
    
    vec2 uvx = mix(uv, uvd, -0.5);
    
    // Primary ghosts (medium+ quality)
    float f4 = 0.0, f42 = 0.0, f43 = 0.0;
    if (uQuality >= 1) {
      vec2 g1 = uvx + 0.4 * pos;
      vec2 g2 = uvx + 0.45 * pos;
      vec2 g3 = uvx + 0.5 * pos;
      float d1 = dot(g1, g1);
      float d2 = dot(g2, g2);
      float d3 = dot(g3, g3);
      f4 = max(0.01 - d1 * d1 * 0.5, 0.0) * 12.0 * uGhostIntensity;
      f42 = max(0.01 - d2 * d2 * 0.5, 0.0) * 10.0 * uGhostIntensity;
      f43 = max(0.01 - d3 * d3 * 0.5, 0.0) * 6.0 * uGhostIntensity;
    }
    
    // Secondary ghosts (high quality only)
    float f5 = 0.0, f52 = 0.0, f53 = 0.0;
    if (uQuality >= 2) {
      uvx = mix(uv, uvd, -0.4);
      vec2 g1 = uvx + 0.2 * pos;
      vec2 g2 = uvx + 0.4 * pos;
      vec2 g3 = uvx + 0.6 * pos;
      float d1 = dot(g1, g1);
      float d2 = dot(g2, g2);
      float d3 = dot(g3, g3);
      f5 = max(0.01 - d1 * d1 * d1 * 8.0, 0.0) * 4.0 * uGhostIntensity;
      f52 = max(0.01 - d2 * d2 * d2 * 8.0, 0.0) * 4.0 * uGhostIntensity;
      f53 = max(0.01 - d3 * d3 * d3 * 8.0, 0.0) * 4.0 * uGhostIntensity;
    }
    
    uvx = mix(uv, uvd, -0.5);
    
    // Streak artifacts (medium+ quality)
    float f6 = 0.0, f62 = 0.0, f63 = 0.0;
    if (uQuality >= 1) {
      vec2 s1 = uvx - 0.3 * pos;
      vec2 s2 = uvx - 0.325 * pos;
      vec2 s3 = uvx - 0.35 * pos;
      float d1 = dot(s1, s1);
      float d2 = dot(s2, s2);
      float d3 = dot(s3, s3);
      f6 = max(0.01 - d1 * sqrt(d1), 0.0) * 12.0 * uStreakIntensity;
      f62 = max(0.01 - d2 * sqrt(d2), 0.0) * 6.0 * uStreakIntensity;
      f63 = max(0.01 - d3 * sqrt(d3), 0.0) * 10.0 * uStreakIntensity;
    }
    
    // Build up color with chromatic aberration
    c.r += f2 + f4 + f5 + f6;
    c.g += f22 + f42 + f52 + f62;
    c.b += f23 + f43 + f53 + f63;
    c = c * 1.3 - vec3(fastLength(uvd) * 0.05);
    
    return c;
  }
  
  // Color correction
  vec3 cc(vec3 color, float factor, float factor2) {
    float w = color.x + color.y + color.z;
    return mix(color, vec3(w) * factor, w * factor2);
  }
  
  void main() {
    vec2 uv = vUv - 0.5;
    uv.x *= uResolution.x / uResolution.y;
    
    // Light position in normalized coordinates
    vec2 lightPos = uLightPosition;
    lightPos.x *= uResolution.x / uResolution.y;
    
    // Calculate lens flare
    vec3 color = uColor * lensflare(uv, lightPos);
    
    // Subtle dithering to reduce banding (simple hash, no noise function needed)
    color -= (hash2(vUv * uResolution) - 0.5) * 0.02;
    
    // Color correction for more natural look
    color = cc(color, 0.5, 0.1);
    
    // Apply intensity
    color *= uIntensity;
    
    // Output with additive-compatible alpha
    float alpha = clamp(dot(color, vec3(0.333)) * 0.5, 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
  }
`
