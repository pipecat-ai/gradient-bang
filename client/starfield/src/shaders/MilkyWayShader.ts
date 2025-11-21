export const milkyWayVertexShader = `
  varying vec3 vWorldPosition;
  varying vec2 vUv;
  
  void main() {
    vUv = uv;
    vWorldPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const milkyWayFragmentShader = `
  precision highp float;
  
  uniform vec2 resolution;
  uniform float intensity;
  uniform vec3 galaxyAxis;
  
  // Band settings
  uniform vec3 bandColor;
  uniform float bandWidth;
  uniform float bandFalloff;
  uniform float bandCoverage;
  uniform float bandCoverageFalloff;
  uniform float bandRotation;
  
  // Core settings
  uniform vec3 coreColor;
  uniform float coreWidth;
  uniform float coreIntensity;
  uniform float coreFalloff;
  
  // Distortion settings
  uniform float distortionAmount;
  uniform float distortionScale;
  
  varying vec3 vWorldPosition;
  varying vec2 vUv;
  
  // Simple hash function for noise
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  
  // Simple 3D noise using hash
  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    
    return mix(
      mix(
        mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
        mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x),
        f.y
      ),
      mix(
        mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
        mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x),
        f.y
      ),
      f.z
    );
  }
  
  void main() {
    vec3 direction = normalize(vWorldPosition);
    vec3 axis = normalize(galaxyAxis);
    
    // Apply simple distortion to the direction
    vec3 distortedDir = direction;
    if (distortionAmount > 0.001) {
      float n = noise(direction * distortionScale) * 2.0 - 1.0;
      distortedDir = normalize(direction + axis * n * distortionAmount);
    }
    
    // Calculate distance from the band center
    float bandDistance = abs(dot(distortedDir, axis));
    
    // Create smooth band gradient
    float bandMask = smoothstep(bandWidth, bandWidth * bandFalloff, bandDistance);
    
    // Early exit if outside band
    if (bandMask < 0.001) {
      gl_FragColor = vec4(0.0);
      return;
    }
    
    // Calculate angular coverage mask
    float coverageMask = 1.0;
    if (bandCoverage < 0.999) {
      // Project direction onto plane perpendicular to axis
      vec3 perpDir = direction - axis * dot(direction, axis);
      perpDir = normalize(perpDir);
      
      // Create reference vector perpendicular to axis (use up vector as reference)
      vec3 refVector = vec3(0.0, 1.0, 0.0);
      // If axis is too close to up, use right vector
      if (abs(dot(axis, refVector)) > 0.9) {
        refVector = vec3(1.0, 0.0, 0.0);
      }
      vec3 ref = normalize(refVector - axis * dot(refVector, axis));
      
      // Calculate angle around the band (0 to 2*PI)
      float angle = atan(dot(perpDir, cross(axis, ref)), dot(perpDir, ref));
      angle = angle + 3.14159265359; // Shift to 0 to 2*PI
      angle = mod(angle + bandRotation, 6.28318530718); // Add rotation offset
      
      // Calculate coverage mask with controllable falloff
      float coverageAngle = bandCoverage * 6.28318530718; // Convert to radians
      float fadeWidth = bandCoverageFalloff * 3.14159265359; // Max PI radians fade
      
      if (angle < coverageAngle) {
        // Fade in at start
        coverageMask = smoothstep(0.0, fadeWidth, angle);
      } else {
        // Fade out after coverage ends
        coverageMask = smoothstep(coverageAngle + fadeWidth, coverageAngle, angle);
      }
    }
    
    // Apply coverage mask
    bandMask *= coverageMask;
    
    if (bandMask < 0.001) {
      gl_FragColor = vec4(0.0);
      return;
    }
    
    // Calculate core brightness (bright center of the band)
    float coreDistance = bandDistance / bandWidth;
    float coreMask = smoothstep(coreWidth, coreWidth * coreFalloff, coreDistance);
    
    // Add subtle variation to the band
    float variation = 1.0;
    if (distortionAmount > 0.001) {
      variation = 0.8 + 0.2 * noise(distortedDir * distortionScale * 0.5);
    }
    
    // Combine band and core colors
    vec3 col = bandColor * bandMask * variation;
    col += coreColor * coreMask * coreIntensity * coverageMask;
    
    // Apply overall intensity
    col *= intensity;
    
    // Smooth edge fade
    float alpha = clamp(bandMask * intensity, 0.0, 1.0);
    
    gl_FragColor = vec4(col, alpha);
  }
`
