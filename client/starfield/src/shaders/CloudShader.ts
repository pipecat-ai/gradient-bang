export const nebulaVertexShader = `
                varying vec2 vUv;
                void main(){
                  vUv = uv;
                  gl_Position = vec4(position, 1.0);
                }
              `

export const nebulaFragmentShader = `
                precision highp float;
                uniform float time;
                uniform float shakePhase;
                uniform vec2 resolution;
                uniform float intensity;
                uniform vec3 nebulaColorPrimary;
                uniform vec3 nebulaColorSecondary;
                uniform vec3 nebulaColorMid;
                uniform float speed;
                uniform float iterPrimary;
                uniform float iterSecondary;
                uniform float domainScale;
                uniform float shakeWarpIntensity;
                uniform float shakeWarpRampTime;
                uniform float nebulaShakeProgress;
                uniform sampler2D noiseTexture;
                uniform float noiseUse;
                uniform vec2 shadowCenter;
                uniform float shadowRadius;
                uniform float shadowSoftness;
                uniform float shadowStrength;
                uniform vec3 cameraRotation;
                uniform float parallaxAmount;
                uniform float noiseReduction;

                varying vec2 vUv;

                const int MAX_ITER = 18;

                // Simplex noise helpers for flow field
                vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
                vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
                float snoise(vec3 v) {
                  const vec2  C = vec2(1.0/6.0, 1.0/3.0);
                  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
                  vec3 i  = floor(v + dot(v, C.yyy));
                  vec3 x0 = v - i + dot(i, C.xxx);
                  vec3 g = step(x0.yzx, x0.xyz);
                  vec3 l = 1.0 - g;
                  vec3 i1 = min(g.xyz, l.zxy);
                  vec3 i2 = max(g.xyz, l.zxy);
                  vec3 x1 = x0 - i1 + C.xxx;
                  vec3 x2 = x0 - i2 + C.yyy;
                  vec3 x3 = x0 - D.yyy;
                  i = mod289(i);
                  vec4 p = permute( permute( permute(
                             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
                           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
                           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
                  float n_ = 0.142857142857;
                  vec3  ns = n_ * D.wyz - D.xzx;
                  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
                  vec4 x_ = floor(j * ns.z);
                  vec4 y_ = floor(j - 7.0 * x_);
                  vec4 x = x_ * ns.x + ns.yyyy;
                  vec4 y = y_ * ns.x + ns.yyyy;
                  vec4 h = 1.0 - abs(x) - abs(y);
                  vec4 b0 = vec4( x.xy, y.xy );
                  vec4 b1 = vec4( x.zw, y.zw );
                  vec4 s0 = floor(b0)*2.0 + 1.0;
                  vec4 s1 = floor(b1)*2.0 + 1.0;
                  vec4 sh = -step(h, vec4(0.0));
                  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
                  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
                  vec3 p0 = vec3(a0.xy,h.x);
                  vec3 p1 = vec3(a0.zw,h.y);
                  vec3 p2 = vec3(a1.xy,h.z);
                  vec3 p3 = vec3(a1.zw,h.w);
                  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
                  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
                  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
                  m = m * m;
                  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
                }

                // Low-frequency flow direction (non-linear, no fixed scroll)
                vec2 flow(vec2 p, float t) {
                  float aVal; float bVal;
                  if (noiseUse > 0.5) {
                    // Blend multiple mip levels via repeated sampling for smoother, less blocky flow
                    float nA = 0.0; float nB = 0.0; float w = 0.6; vec2 pp;
                    pp = p * 0.5 + vec2(t * 0.03, 0.0);
                    nA += w * (texture2D(noiseTexture, pp          ).r * 2.0 - 1.0);
                    nA += (w*0.5) * (texture2D(noiseTexture, pp*2.0 ).r * 2.0 - 1.0);
                    nA += (w*0.25)* (texture2D(noiseTexture, pp*4.0 ).r * 2.0 - 1.0);
                    pp = (p + 13.7) * 0.9 + vec2(t * 0.05, 0.0);
                    nB += w * (texture2D(noiseTexture, pp          ).r * 2.0 - 1.0);
                    nB += (w*0.5) * (texture2D(noiseTexture, pp*2.0 ).r * 2.0 - 1.0);
                    nB += (w*0.25)* (texture2D(noiseTexture, pp*4.0 ).r * 2.0 - 1.0);
                    aVal = 6.2831853 * clamp(nA, -1.0, 1.0);
                    bVal = 6.2831853 * clamp(nB, -1.0, 1.0);
                  } else {
                    aVal = 6.2831853 * snoise(vec3(p * 0.5, t * 0.03));
                    bVal = 6.2831853 * snoise(vec3((p + 13.7) * 0.9, t * 0.05));
                  }
                  vec2 f1 = vec2(cos(aVal), sin(aVal));
                  vec2 f2 = vec2(cos(bVal), sin(bVal));
                  vec2 dir = normalize(f1 * 0.6 + f2 * 0.4);
                  return dir;
                }

                float fieldFunc(vec3 p, float s, int iter) {
                  float accum = s / 4.0;
                  float prev = 0.0;
                  float tw = 0.0;
                  for (int i = 0; i < MAX_ITER; ++i) {
                    if (i >= iter) { break; }
                    float mag = dot(p, p);
                    p = abs(p) / max(mag, 1e-5) + vec3(-0.5, -0.4, -1.487);
                    float w = exp(-float(i) / 5.0);
                    accum += w * exp(-9.025 * pow(abs(mag - prev), 2.2));
                    tw += w;
                    prev = mag;
                  }
                  return max(0.0, 5.2 * accum / max(tw, 1e-4) - 0.65);
                }

                vec3 nrand3(vec2 co) {
                  vec3 a = fract(cos(co.x*8.3e-3 + co.y) * vec3(1.3e5, 4.7e5, 2.9e5));
                  vec3 b = fract(sin(co.x*0.3e-3 + co.y) * vec3(8.1e5, 1.0e5, 0.1e5));
                  return mix(a, b, 0.5);
                }

                vec4 starLayer(vec2 p, float t) {
                  vec2 seed = 1.9 * p.xy;
                  float scale = max(resolution.x, 600.0);
                  seed = floor(seed * scale / 1.5);
                  vec3 rnd = nrand3(seed);
                  vec4 col = vec4(pow(rnd.y, 17.0));
                  float mul = 10.0 * rnd.x;
                  col.xyz *= sin(t * mul + mul) * 0.25 + 1.0;
                  return col;
                }

                void main() {
                  vec2 fragCoord = vUv * resolution;
                  // Adjust timing to restore flowing effect - multiply by 60 to maintain visual speed
                  float t = (time * speed * 60.0) / max(resolution.x, 1.0) * 1000.0;
                  vec2 uv = 2.0 * fragCoord / resolution - 1.0;
                  vec2 uvs = uv * resolution / max(resolution.x, resolution.y);
                  
                  // Apply parallax offset based on camera rotation for depth illusion
                  vec2 parallaxOffset = vec2(-cameraRotation.y, cameraRotation.x) * parallaxAmount;
                  uvs += parallaxOffset;
                  
                  // Apply paint-like domain warp instead of fixed scrolling
                  vec2 uvsFlow = uvs + flow(uvs * 0.6, t) * (0.02 * speed * 100.0);
                  
                  // Add shake-based warping effect only when actually shaking
                  if (nebulaShakeProgress > 0.0) {
                    // Use nebulaShakeProgress for BOTH timing and intensity to get proper gradual buildup
                    float shakeTime = nebulaShakeProgress * 20.0; // Scale progress to create timing
                    
                    // Make the warping effect more visible by scaling it up
                    float shakeWarp = shakeWarpIntensity * 2.0 * nebulaShakeProgress; // Scale by smooth progress
                    uvsFlow += vec2(
                      sin(shakeTime * 8.0) * shakeWarp,  // Use scaled progress for timing
                      cos(shakeTime * 6.0) * shakeWarp   // Use scaled progress for timing
                    );
                    
                    // Gradually increase flow field intensity during shake
                    // Scale down the flow field effect to match the gradual buildup
                    float flowFieldIntensity = nebulaShakeProgress * nebulaShakeProgress; // Square the progress for smoother buildup
                    uvsFlow += flow(uvs * 0.8, t * 2.0) * (shakeWarpIntensity * speed * 100.0) * flowFieldIntensity;
                  }
                  
                  vec3 p = vec3(uvsFlow / (2.5 * domainScale), 0.0) + vec3(0.8, -1.3, 0.0);
                  p += 0.45 * vec3(sin(t / 32.0), sin(t / 24.0), sin(t / 64.0));
                  float freqs0 = 0.45;
                  float freqs1 = 0.4;
                  float freqs2 = 0.15;
                  float freqs3 = 0.9;
                  float v = (1.0 - exp((abs(uv.x) - 1.0) * 6.0)) * (1.0 - exp((abs(uv.y) - 1.0) * 6.0));

                  float t1 = fieldFunc(p, freqs2, int(iterPrimary));

                  vec3 p2 = vec3(uvsFlow / ((4.0 * domainScale) + sin(t * 0.11) * 0.2 + 0.2 + sin(t * 0.15) * 0.3 + 0.4), 4.0) + vec3(2.0, -1.3, -1.0);
                  p2 += 0.16 * vec3(sin(t / 32.0), sin(t / 24.0), sin(t / 64.0));
                  float t2 = fieldFunc(p2, freqs3, int(iterSecondary));
                  // Secondary layer contribution, now as scalar density and colorized with nebulaColorSecondary
                  float c2d = (5.5 * t2 * t2 * t2 + 2.1 * t2 * t2 + 2.2 * t2 * freqs0) * mix(0.5, 0.2, v);

                  vec4 starColour = vec4(0.0);
                  starColour += starLayer(p.xy, t);
                  starColour += starLayer(p2.xy, t);

                  float brightness = 1.0;
                  // Primary layer base as scalar density
                  float baseD = (1.5 * freqs2 * t1 * t1 * t1 + 1.2 * freqs1 * t1 * t1 + freqs3 * t1) * mix(freqs3 - 0.3, 1.0, v);
                  
                  // Combine density values into a single ramp for color mixing
                  float density = clamp(baseD + c2d * 0.5, 0.0, 1.0);
                  
                  // Mix between the three colors based on density (like the original shader)
                  vec3 col = mix(nebulaColorPrimary, nebulaColorMid, clamp(density * 2.0, 0.0, 1.0));
                  col = mix(col, nebulaColorSecondary, clamp((density - 0.5) * 2.0, 0.0, 1.0));
                  
                  // Apply brightness
                  col = col * brightness;
                  
                  // Scale star contribution based on intensity to reduce noise at high intensities
                  // At low intensity (0.1), stars are at full strength (1.0)
                  // At high intensity (1.0+), stars are scaled down significantly (0.1)
                  float starScale = mix(1.0, 0.1, smoothstep(0.1, 1.0, intensity));
                  col += starColour.xyz * starScale;
                  
                  // Additional noise reduction at high intensities using threshold-based filtering
                  // This helps smooth out any remaining small noise dots
                  if (intensity > 0.5) {
                    float noiseThreshold = mix(0.0, noiseReduction, (intensity - 0.5) * 2.0); // 0.0 at 0.5 intensity, noiseReduction at 1.0+ intensity
                    col = max(col, noiseThreshold); // Clamp low values to reduce noise
                  }

                  // screen-space radial shadow mask (aspect-correct)
                  vec2 dp = vUv - shadowCenter;
                  dp.x *= resolution.x / max(resolution.y, 1.0);
                  float d = length(dp);
                  float m = smoothstep(shadowRadius, shadowRadius + max(shadowSoftness, 1e-4), d);
                  float darken = 1.0 - shadowStrength * (1.0 - m);
                  col *= darken;

                  gl_FragColor = vec4(col * intensity, clamp(intensity, 0.0, 1.0));
                }
              `
