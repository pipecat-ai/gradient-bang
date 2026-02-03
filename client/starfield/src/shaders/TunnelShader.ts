import { createNoiseUtilsBasic } from "@/utils/noise"

export const tunnelVertexShader = `
  varying vec2 vUv;
  varying vec3 vViewDirection;
  varying vec3 vWorldDirection;
  
  void main() {
    vUv = uv;
    vWorldDirection = normalize(position);
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    vViewDirection = normalize(viewPos.xyz);
    gl_Position = projectionMatrix * viewPos;
  }
`

export const tunnelFragmentShader = `
  precision highp float;
  
  #define TAU 6.28318
  #define PI 3.141592
  
  uniform float uTime;
  uniform float speed;
  uniform float rotationSpeed;
  uniform float rotationAngle;
  uniform float tunnelDepth;
  uniform vec3 tunnelColor;
  uniform float noiseAnimationSpeed;
  uniform float opacity;
  uniform float contrast;
  uniform float centerHole;
  uniform float centerSoftness;
  uniform float pixelation;
  uniform bool followCamera;
  
  varying vec2 vUv;
  varying vec3 vViewDirection;
  varying vec3 vWorldDirection;
  
  ${createNoiseUtilsBasic(3)}
  
  void main() {
    vec4 col = vec4(0.0);
    
    vec3 direction = followCamera ? normalize(vViewDirection) : normalize(vWorldDirection);
    
    float radialDist = length(direction.xy);
    float depth = -direction.z;
    float z = depth / max(radialDist, 0.001);
    
    float focal_depth = tunnelDepth;
    float tunnelZ = z * focal_depth + uTime * speed;
    
    float angle = atan(direction.y, direction.x);
    angle -= rotationAngle * TAU;
    
    // Apply pixelation by quantizing angle and depth
    if (pixelation > 0.0) {
      float pixelSize = pixelation * 0.01;
      float angularPixels = TAU / pixelSize;
      angle = floor(angle * angularPixels) / angularPixels;
      
      float depthPixels = 1.0 / pixelSize;
      z = floor(z * depthPixels) / depthPixels;
      radialDist = floor(radialDist * depthPixels * 2.0) / (depthPixels * 2.0);
    }
    
    float depthScale = focal_depth * 10.0;
    float circleScale = 1.5 * depthScale;
    float noiseX = cos(angle) * circleScale;
    float noiseY = sin(angle) * circleScale;
    
    float timeOffset = uTime * speed * 0.3;
    
    vec3 noiseCoord = vec3(noiseX, noiseY, timeOffset + noiseAnimationSpeed * uTime);
    float val = fBm3(noiseCoord);
    
    float streakIntensity = smoothstep(0.0, 2.0, z) * (0.3 + focal_depth);
    float streak = sin(angle * 8.0 + tunnelZ * 2.0) * 0.5 + 0.5;
    val = mix(val, val * (0.7 + streak * 0.6), streakIntensity);
    
    // Center hole: fade out towards center based on radial distance
    float holeRadius = centerHole * 0.1;
    float falloffStart = holeRadius * (1.0 - centerSoftness);
    float holeMask = smoothstep(falloffStart, holeRadius, radialDist);
    
    val = clamp(val, 0.0, 1.0);
    
    val = pow(val, 1.0 / contrast);
    val = clamp(val, 0.0, 1.0);
    
    col.rgb = tunnelColor * vec3(val);
    
    float whiteThreshold = mix(0.55, 0.75, (contrast - 0.5) / 2.5);
    vec3 white = 0.35 * vec3(smoothstep(whiteThreshold, 1.0, val));
    col.rgb += white;
    col.rgb = clamp(col.rgb, 0.0, 1.0);
    
    col.a = opacity * holeMask;
    
    gl_FragColor = col;
  }
`
