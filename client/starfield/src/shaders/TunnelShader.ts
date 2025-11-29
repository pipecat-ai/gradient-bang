import { glslNoiseUtilsBasic } from "@/utils/noise"

export const tunnelVertexShader = `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  
  void main() {
    vUv = uv;
    vWorldPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const tunnelFragmentShader = `
  precision highp float;
  
  #define TAU 6.28318
  #define PI 3.141592
  
  uniform float uTime;
  uniform vec2 resolution;
  uniform float speed;
  uniform float rotationSpeed;
  uniform float tunnelDepth;
  uniform float whiteoutPeriod;
  uniform bool enableWhiteout;
  uniform vec3 tunnelColor;
  uniform float noiseAnimationSpeed;
  
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  
  ${glslNoiseUtilsBasic}
  
  void main() {
    float t = mod(uTime, whiteoutPeriod);
    t = t / whiteoutPeriod; // Normalized time
    
    vec4 col = vec4(0.0);
    
    // Use spherical direction from camera (like Nebula)
    vec3 direction = normalize(vWorldPosition);
    
    // The tunnel goes along -Z axis (forward), so we use -direction.z for depth
    // Calculate radial distance from the forward axis
    float radialDist = length(direction.xy);
    
    // Depth calculation - points further along -Z appear deeper in tunnel
    float depth = -direction.z;
    
    // Avoid division by zero and create proper perspective
    float z = depth / max(radialDist, 0.001);
    
    // The focal_depth controls how "deep" the tunnel looks
    float focal_depth = tunnelDepth;
    if (enableWhiteout) {
      focal_depth = mix(tunnelDepth, tunnelDepth * 0.1, smoothstep(0.65, 0.9, t));
    }
    
    // Create polar coordinates for the tunnel
    vec2 polar;
    polar.y = z * focal_depth + uTime * speed;
    
    // Calculate angle for rotation - use atan for proper seamless wrapping
    float angle = atan(direction.y, direction.x);
    angle = angle / TAU; // Normalize to [0, 1]
    angle -= uTime * rotationSpeed;
    
    // Use seamless wrapping with mirroring to remove seam
    float x = fract(angle);
    x = abs(x * 2.0 - 1.0); // Mirror at 0.5 to remove seam
    polar.x = x;
    
    // Generate tunnel texture using fBm3
    // noiseAnimationSpeed controls how fast the noise evolves (0 = static)
    float val = 0.45 + 0.55 * fBm3(
      vec3(vec2(2.0, 0.5) * polar, noiseAnimationSpeed * uTime));
    val = clamp(val, 0.0, 1.0);
    
    // Apply tunnel color
    col.rgb = tunnelColor * vec3(val);
    
    // Add white spots for detail
    vec3 white = 0.35 * vec3(smoothstep(0.55, 1.0, val));
    col.rgb += white;
    col.rgb = clamp(col.rgb, 0.0, 1.0);
    
    float w_total = 0.0, w_out = 0.0;
    if (enableWhiteout) {
      // Fade in and out from white
      float w_in = abs(1.0 - 1.0 * smoothstep(0.0, 0.25, t));
      w_out = abs(1.0 * smoothstep(0.8, 1.0, t));
      w_total = max(w_in, w_out);
    }
    
    // Add the white disk at the center (based on radial distance)
    float disk_size = max(0.025, 1.5 * w_out);
    float disk_col = exp(-(radialDist - disk_size) * 4.0);
    col.rgb += clamp(vec3(disk_col), 0.0, 1.0);
    
    if (enableWhiteout) {
      col.rgb = mix(col.rgb, vec3(1.0), w_total);
    }
    
    gl_FragColor = vec4(col.rgb, 1.0);
  }
`
