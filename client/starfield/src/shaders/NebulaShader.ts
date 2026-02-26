export const nebulaVertexShader = `
                varying vec3 vWorldPosition;
                varying vec2 vUv;
                void main(){
                  vUv = uv;
                  vWorldPosition = position;
                  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
              `

export const nebulaFragmentShader = `
                precision highp float;
                uniform vec2 resolution;
                uniform float intensity;
                uniform vec3 color;
                uniform vec3 nebulaColorPrimary;
                uniform vec3 nebulaColorSecondary;
                uniform float iterPrimary;
                uniform float iterSecondary;
                uniform float domainScale;
                
                // Domain warp controls
                uniform vec3 warpOffset;        // Domain fold offset (-0.5, -0.4, -1.487 default)
                uniform float warpDecay;        // Iteration decay rate (5.0 default)

                varying vec2 vUv;
                varying vec3 vWorldPosition;

                const int MAX_ITER = 18;

                // Procedural field function for nebula generation
                float fieldFunc(vec3 p, float s, int iter) {
                  float accum = s / 4.0;
                  float prev = 0.0;
                  float tw = 0.0;
                  for (int i = 0; i < MAX_ITER; ++i) {
                    if (i >= iter) { break; }
                    float mag = dot(p, p);
                    p = abs(p) / max(mag, 1e-5) + warpOffset;
                    float w = exp(-float(i) / max(warpDecay, 0.01));
                    accum += w * exp(-9.025 * min(pow(abs(mag - prev), 2.2), 20.0));
                    tw += w;
                    prev = mag;
                  }
                  return max(0.0, 5.2 * accum / max(tw, 1e-4) - 0.65);
                }

                // Fast pseudo-random function for star field
                vec3 nrand3(vec2 co) {
                  vec3 a = fract(cos(co.x*8.3e-3 + co.y) * vec3(1.3e5, 4.7e5, 2.9e5));
                  vec3 b = fract(sin(co.x*0.3e-3 + co.y) * vec3(8.1e5, 1.0e5, 0.1e5));
                  return mix(a, b, 0.5);
                }

                vec4 starLayer(vec2 p) {
                  float scale = max(resolution.x, 600.0);
                  vec2 seed = floor(1.9 * p * scale / 1.5);
                  vec3 rnd = nrand3(seed);
                  return vec4(pow(rnd.y, 17.0));
                }

                void main() {
                  vec3 direction = normalize(vWorldPosition);
                  
                  // 3D position for seamless spherical noise sampling (static)
                  vec3 p3d = direction * 2.0;
                  
                  // 2D spherical UVs for vignette and stars
                  float theta = atan(direction.x, -direction.z);
                  float phi = asin(direction.y);
                  vec2 sphericalUV = vec2(theta / 6.28318530718 + 0.5, phi / 3.14159265359 + 0.5);
                  vec2 uv = sphericalUV * 2.0 - 1.0;
                  
                  // Primary noise layer (static)
                  vec3 p = p3d / (2.5 * domainScale) + vec3(0.8, -1.3, 0.0);
                  float t1 = fieldFunc(p, 0.15, int(iterPrimary));

                  // Secondary noise layer (static)
                  vec3 p2 = p3d / (4.0 * domainScale) + vec3(2.0, -1.3, -1.0);
                  float t2 = fieldFunc(p2, 0.9, int(iterSecondary));

                  // Vignette mask for edge fade
                  float v = (1.0 - exp((abs(uv.x) - 1.0) * 6.0)) * (1.0 - exp((abs(uv.y) - 1.0) * 6.0));
                  
                  // Combine layers
                  float baseD = (0.225 * t1 * t1 * t1 + 0.48 * t1 * t1 + 0.9 * t1) * mix(0.6, 1.0, v);
                  float c2d = (5.5 * t2 * t2 * t2 + 2.1 * t2 * t2 + 0.99 * t2) * mix(0.5, 0.2, v);

                  // Add star layers (static)
                  vec4 stars = starLayer(sphericalUV * 4.0) + starLayer(sphericalUV * 6.0);
                  float starScale = mix(1.0, 0.1, smoothstep(0.1, 1.0, intensity));
                  
                  // Final color composition
                  vec3 col = baseD * nebulaColorPrimary + c2d * nebulaColorSecondary + stars.xyz * starScale;
                  col *= color * intensity;

                  gl_FragColor = vec4(col, clamp(intensity, 0.0, 1.0));
                }
              `
