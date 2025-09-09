export const backgroundVertexShader = `
                  varying vec2 vUv;
                  void main(){
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                  }
                `;

export const backgroundFragmentShader = `
                  precision highp float;
                  uniform sampler2D tDiffuse;
                  uniform float opacity;
                  uniform float time;
                  uniform float shakeIntensity;
                  uniform float warpProgress;
                  uniform float tunnelEffect;
                  uniform float glitchIntensity;
                  uniform float pixelFlickerRate;
                  uniform float shakePhase;
                  uniform float shakeAmplitude;
                  varying vec2 vUv;
 
                  // Simple noise function for distortion
                  float noise(vec2 p) {
                    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
                  }
 
                  void main(){
                    vec2 uv = vUv;
                    
                    // Apply pixel-ish shake distortion similar to stars
                    if (shakeIntensity > 0.0) {
                      float phase = shakePhase;
                      // small high-frequency jitter
                      vec2 jitter = vec2(
                        sin(phase * 120.0 + uv.y * 60.0),
                        cos(phase * 115.0 + uv.x * 55.0)
                      ) * (shakeAmplitude * 0.5) * shakeIntensity;
                      // lower-frequency wobble
                      vec2 wobble = vec2(
                        sin(phase * 50.0 + uv.y * 20.0),
                        cos(phase * 47.0 + uv.x * 20.0)
                      ) * shakeAmplitude * shakeIntensity;
                      uv += jitter + wobble;
                    }
                    
                    // Apply warp/tunnel distortion
                    float effectStrength = max(warpProgress, tunnelEffect);
                    if (effectStrength > 0.0) {
                      vec2 center = vec2(0.5);
                      vec2 offset = uv - center;
                      float dist = length(offset);
                      
                      // Barrel distortion for warp effect
                      float barrel = 1.0 + effectStrength * 0.3;
                      float distorted = pow(dist, barrel);
                      vec2 direction = normalize(offset);
                      uv = center + direction * distorted;
                    }
 
                    vec4 c = texture2D(tDiffuse, uv);
                    
                    // No masking here; planet image renders fully. Shadow handled by separate plane.
                    c.a *= opacity;
                    gl_FragColor = c;
                  }
                `;
