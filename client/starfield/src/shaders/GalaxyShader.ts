// Vertex shader for baking galaxy to equirectangular texture
export const galaxyBakeVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Fragment shader for baking galaxy to equirectangular texture
export const galaxyBakeFragmentShader = `
  precision highp float;
  
  uniform float uIntensity;
  uniform float uSpread;
  uniform vec3 uColor1;
  uniform vec3 uColor2;
  uniform vec3 uGalaxyCenter;
  uniform vec3 uGalaxyUp;
  uniform float uRotation;
  uniform int uOctaves;
  
  varying vec2 vUv;
  
  #define PI 3.141592654
  
  const mat2 FBM_ROT = mat2(1.1016, 1.7156, -1.7156, 1.1016);
  
  // Fast integer-based hash
  vec2 hash2(vec2 p) {
    uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u);
    uint n = (q.x ^ q.y) * 1597334673u;
    uvec2 rz = uvec2(n, n * 48271u);
    return vec2(rz & uvec2(0x7fffffffu)) / float(0x7fffffff);
  }
  
  vec2 shash2(vec2 p) {
    return -1.0 + 2.0 * hash2(p);
  }
  
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    
    return 2.0 * mix(
      mix(dot(shash2(i), f),
          dot(shash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
      mix(dot(shash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
          dot(shash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  
  // FBM with configurable octaves
  float fbm(vec2 p) {
    p *= 5.0;
    float h = 0.0;
    float a = 1.0;
    float totalWeight = 0.0;
    
    h += a * noise(p); totalWeight += a;
    if (uOctaves <= 1) return h * 0.3 / totalWeight;
    a *= 0.5; p = FBM_ROT * p + vec2(10.7, 8.3);
    
    h += a * noise(p); totalWeight += a;
    if (uOctaves <= 2) return h * 0.3 / totalWeight;
    a *= 0.5; p = FBM_ROT * p + vec2(10.7, 8.3);
    
    h += a * noise(p); totalWeight += a;
    if (uOctaves <= 3) return h * 0.3 / totalWeight;
    a *= 0.5; p = FBM_ROT * p + vec2(10.7, 8.3);
    
    h += a * noise(p); totalWeight += a;
    if (uOctaves <= 4) return h * 0.3 / totalWeight;
    a *= 0.5; p = FBM_ROT * p + vec2(10.7, 8.3);
    
    h += a * noise(p); totalWeight += a;
    return h * 0.3 / totalWeight;
  }
  
  // Calculate galaxy color for a given direction
  vec4 calcGalaxy(vec3 rd, vec3 tangent, vec3 bitangent, float cosR, float sinR) {
    float dotCenter = dot(rd, uGalaxyCenter);
    
    // Fade out when looking at the back hemisphere
    float hemisphereFade = smoothstep(-0.2, 0.3, dotCenter);
    if (hemisphereFade < 0.001) {
      return vec4(0.0);
    }
    
    vec3 projected = rd - uGalaxyCenter * dotCenter;
    
    float localX = dot(projected, tangent);
    float localY = dot(projected, bitangent);
    
    float rotX = cosR * localX - sinR * localY;
    float rotY = sinR * localX + cosR * localY;
    
    float gcc = rotX * rotX + rotY * rotY + 0.001;
    // Spread controls the falloff rate (higher spread = wider band)
    float gcx = exp(-abs(1.5 / uSpread * rotX));  // Band width
    float gcy = exp(-abs(4.0 / uSpread * rotY));  // Band thickness
    float bandIntensity = gcy * gcx;
    
    // Early-out for pixels far from galaxy
    if (bandIntensity < 0.01 && gcc > 0.1) {
      vec3 col = uColor1 * (0.002 / gcc) * uIntensity * hemisphereFade;
      float alpha = clamp(length(col) * 2.0, 0.0, 1.0);
      return vec4(col, alpha);
    }
    
    float thetaNoise = acos(rd.y);
    float phiNoise = atan(rd.x, rd.z);
    float h1 = fbm(2.0 * vec2(thetaNoise, phiNoise));
    float cf = smoothstep(0.05, -0.2, -h1);
    
    vec3 col = uColor2 * bandIntensity;
    col += uColor1 * (0.002 / gcc);
    col *= mix(mix(0.15, 1.0, bandIntensity), 1.0, cf);
    col *= uIntensity * hemisphereFade;
    
    float alpha = clamp(length(col) * 2.0, 0.0, 1.0);
    return vec4(col, alpha);
  }
  
  void main() {
    // Convert UV to spherical direction (equirectangular)
    float phi = (vUv.x * 2.0 - 1.0) * PI;
    float theta = vUv.y * PI;
    
    vec3 rd = vec3(
      sin(theta) * sin(phi),
      cos(theta),
      sin(theta) * cos(phi)
    );
    
    // Build local coordinate frame around galaxy center
    vec3 tangent = normalize(cross(uGalaxyCenter, uGalaxyUp));
    vec3 bitangent = cross(tangent, uGalaxyCenter);
    
    float cosR = cos(uRotation);
    float sinR = sin(uRotation);
    
    // Edge blending to fix equirectangular seam
    float edgeDist = abs(vUv.x - 0.5) * 2.0;
    float blendZone = 0.9;
    float blendFactor = smoothstep(blendZone, 1.0, edgeDist);
    
    if (blendFactor > 0.001) {
      vec4 col1 = calcGalaxy(rd, tangent, bitangent, cosR, sinR);
      
      float wrappedPhi = phi + (phi > 0.0 ? -2.0 * PI : 2.0 * PI);
      vec3 rdWrapped = vec3(
        sin(theta) * sin(wrappedPhi),
        cos(theta),
        sin(theta) * cos(wrappedPhi)
      );
      vec4 col2 = calcGalaxy(rdWrapped, tangent, bitangent, cosR, sinR);
      
      gl_FragColor = mix(col1, col2, blendFactor);
    } else {
      gl_FragColor = calcGalaxy(rd, tangent, bitangent, cosR, sinR);
    }
  }
`

// Vertex shader for displaying the baked texture on a sphere
export const galaxyDisplayVertexShader = `
  varying vec3 vDirection;
  
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Fragment shader for displaying the baked equirectangular texture
export const galaxyDisplayFragmentShader = `
  precision highp float;
  
  uniform sampler2D uTexture;
  
  varying vec3 vDirection;
  
  #define PI 3.141592654
  
  void main() {
    vec3 rd = normalize(vDirection);
    
    // Convert direction to equirectangular UV coordinates
    float phi = atan(rd.x, rd.z);
    float theta = acos(rd.y);
    
    vec2 uv = vec2(
      (phi + PI) / (2.0 * PI),
      theta / PI
    );
    
    gl_FragColor = texture2D(uTexture, uv);
  }
`
