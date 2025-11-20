export const nebulaVertexShader = `
                        varying vec3 vPosition;
                        varying vec2 vUv;
                        varying vec4 vScreenPosition;

                        void main() {
                            vPosition = position;
                            vUv = uv;
                            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                            vScreenPosition = projectionMatrix * mvPosition;
                            gl_Position = vScreenPosition;
                        }
                    `;

export const nebulaFragmentShader = `
                        uniform float time;
                        uniform sampler2D noiseTexture;
                        uniform float nebulaNoiseUse;
                        uniform vec3 nebulaColor1;
                        uniform vec3 nebulaColor2;
                        uniform float intensity;
                        uniform float warpProgress;
                        uniform float tunnelEffect;
                        uniform vec3 bandAxis;
                        uniform float bandWidth;
                        uniform float bandSoftness;
                        uniform float baseNoiseScale;
                        uniform float flowSpeed;
                        uniform float idleNoiseSpeed;
                        uniform float nebulaIdleNoiseSpeed;
                        uniform float warpNoiseSpeed;
                        uniform float posterizeLevels;
                        uniform float ditherAmount;
                        uniform float pixelateScale;
                        uniform float driftSpeed;
                        uniform float anisotropy;
                        uniform float domainWarpStrength;
                        uniform float filamentContrast;
                        uniform float darkLaneStrength;
                        uniform vec3 nebulaColorMid;
                        uniform vec2 shadowCenter;
                        uniform float shadowRadius;
                        uniform float shadowSoftness;
                        uniform float shadowStrength;
                        uniform float performanceMode; // 0.0 = full quality, 1.0 = performance mode
                        uniform vec2 resolution;

                        varying vec2 vUv;
                        varying vec3 vPosition;
                        varying vec4 vScreenPosition;

                        // HEAVILY OPTIMIZED: Simple 2D noise instead of triplanar
                        float fastNoise(vec2 uv, float timeShift) {
                            if (performanceMode > 0.5) {
                                // Performance mode: single texture sample
                                return texture2D(noiseTexture, uv + vec2(timeShift, 0.0)).r * 2.0 - 1.0;
                            } else {
                                // Quality mode: simple 2D noise
                                return texture2D(noiseTexture, uv + vec2(timeShift, 0.0)).r * 2.0 - 1.0;
                            }
                        }

                        // HEAVILY OPTIMIZED: Reduced FBM with only 2 octaves
                        float fastFBM(vec2 uv, float scale, float timeShift) {
                            float v = 0.0;
                            float a = 0.6;
                            float freq = scale;
                            
                            // Only 2 octaves for performance
                            for (int i = 0; i < 2; ++i) {
                                v += a * fastNoise(uv * freq, timeShift);
                                freq *= 2.0;
                                a *= 0.5;
                            }
                            return clamp(v, -1.0, 1.0);
                        }

                        // HEAVILY OPTIMIZED: Simplified simplex noise (removed complex math)
                        float simpleNoise(vec3 v) {
                            // Simplified to basic hash function
                            vec3 i = floor(v);
                            vec3 f = fract(v);
                            f = f * f * (3.0 - 2.0 * f);
                            
                            float n = i.x + i.y * 157.0 + i.z * 113.0;
                            return fract(sin(n) * 43758.5453);
                        }

                        // HEAVILY OPTIMIZED: Simplified flow field
                        vec2 simpleFlow(vec2 p, float t) {
                            if (performanceMode > 0.5) {
                                // Performance mode: static flow
                                return vec2(0.0, 0.0);
                            }
                            
                            float s = fastNoise(p * 0.8, t * 0.02) * 0.5 + 0.5;
                            float a = 6.2831853 * s;
                            return vec2(cos(a), sin(a)) * 0.01; // Reduced magnitude
                        }

                        void main() {
                            // Base uv with simplified distortion
                            float effectStrength = max(warpProgress, tunnelEffect);
                            vec2 uv = vUv;
                            
                            // Simplified pixelation
                            if (pixelateScale > 0.0) {
                                vec2 grid = floor(uv * pixelateScale) / pixelateScale;
                                uv = grid;
                            }
                            
                            // Simplified drift (only during warp)
                            if (effectStrength > 0.1) {
                                vec2 driftDir = normalize(vec2(bandAxis.x, bandAxis.y));
                                if (all(equal(driftDir, vec2(0.0)))) {
                                    driftDir = vec2(1.0, 0.0);
                                }
                                uv += driftDir * driftSpeed * time * effectStrength * 0.5; // Reduced effect
                            }

                            // Simplified barrel distortion
                            vec2 c = uv - 0.5;
                            float r = length(c);
                            float barrel = mix(1.0, 0.8, effectStrength * 0.5); // Reduced effect
                            c = normalize(c) * pow(r, barrel);
                            
                            // Simplified spiral (only during warp)
                            if (effectStrength > 0.1) {
                                float rot = effectStrength * (0.5 + r * 1.5); // Reduced rotation
                                float cs = cos(rot), sn = sin(rot);
                                c = mat2(cs,-sn,sn,cs) * c;
                            }
                            
                            uv = c + 0.5;

                            // HEAVILY OPTIMIZED: Simplified flow (only during warp)
                            vec2 f = vec2(0.0);
                            if (effectStrength > 0.1 && performanceMode < 0.5) {
                                float flowT = time * warpNoiseSpeed * effectStrength;
                                f = simpleFlow(uv * 1.2, flowT) * effectStrength;
                            }
                            uv += f;

                            // HEAVILY OPTIMIZED: Simplified noise generation
                            float baseScale = baseNoiseScale;
                            float idleTime = time * nebulaIdleNoiseSpeed * 0.5; // Reduced speed
                            float warpTime = time * warpNoiseSpeed * effectStrength * 0.5; // Reduced speed
                            float tn = effectStrength > 0.1 ? warpTime : idleTime;
                            
                            // Simplified stretching
                            vec2 suv = uv;
                            if (anisotropy > 1.0) {
                                mat2 stretch = mat2(anisotropy, 0.0, 0.0, 1.0);
                                suv = (stretch * (uv - 0.5)) + 0.5;
                            }
                            
                            // HEAVILY OPTIMIZED: Simplified domain warp (only in quality mode)
                            if (domainWarpStrength > 0.0 && performanceMode < 0.5) {
                                vec2 warp = vec2(
                                    fastNoise(suv * 1.5, idleTime * 0.5),
                                    fastNoise(suv * 1.8 + 37.1, idleTime * 0.5)
                                );
                                suv += warp * domainWarpStrength * 0.5; // Reduced strength
                            }

                            // HEAVILY OPTIMIZED: Simplified FBM with only 2 octaves
                            float value = 0.0;
                            float ridged = 0.0;
                            float amp = 0.6;
                            float freq = baseScale;
                            
                            // Only 2 octaves for performance
                            for (int i = 0; i < 2; i++) {
                                float n = fastNoise(suv * freq, tn * 0.1);
                                value += amp * n;
                                ridged += amp * (1.0 - abs(n));
                                freq *= 1.5; // Reduced frequency scaling
                                amp *= 0.6;  // Reduced amplitude decay
                            }
                            
                            value = 0.5 + 0.5 * value;
                            ridged = clamp(ridged, 0.0, 1.0);
                            
                            // Simplified filaments
                            float filaments = mix(value, ridged, filamentContrast * 0.5);
                            
                            // HEAVILY OPTIMIZED: Simplified dust lanes
                            float lanes;
                            if (performanceMode > 0.5) {
                                // Performance mode: simple noise
                                lanes = fastNoise(suv * 0.8, idleTime * 0.3) * 0.5 + 0.5;
                            } else {
                                // Quality mode: single FBM call
                                lanes = fastFBM(suv * 0.8, 1.0, idleTime * 0.3);
                                lanes = lanes * 0.5 + 0.5;
                            }
                            
                            lanes = smoothstep(0.2, 0.7, lanes);
                            filaments = filaments * (1.0 - darkLaneStrength * 0.5 * (1.0 - lanes));
                            
                            // Simplified shaping
                            float valueShaped = smoothstep(0.15, 0.9, filaments);
                            valueShaped = pow(valueShaped, 1.2);

                            // Simplified galactic band
                            vec3 dir = normalize(vPosition);
                            float d = abs(dot(dir, normalize(bandAxis)));
                            float band = 1.0 - smoothstep(bandWidth, bandWidth + bandSoftness, d);
                            float outside = 0.2 * (1.0 - band); // Reduced outside influence
                            float nebulaMask = clamp(band + outside, 0.0, 1.0);

                            // Simplified color mixing
                            vec3 mid = nebulaColorMid;
                            float tRamp = valueShaped;
                            vec3 color = mix(nebulaColor1, mid, clamp(tRamp * 2.0, 0.0, 1.0));
                            color = mix(color, nebulaColor2, clamp((tRamp - 0.5) * 2.0, 0.0, 1.0));
                            
                            // Simplified posterization
                            if (posterizeLevels > 1.0) {
                                float levels = min(posterizeLevels, 4.0); // Cap at 4 levels for performance
                                color = floor(color * levels) / levels;
                            }

                            // Simplified dithering
                            if (ditherAmount > 0.0 && performanceMode < 0.5) {
                                vec2 f = fract(uv * 4.0); // Reduced from 8.0 to 4.0
                                float bayer = step(0.5, fract(sin(dot(f, vec2(12.9898,78.233))) * 43758.5453));
                                valueShaped = clamp(valueShaped + (bayer * 2.0 - 1.0) * (ditherAmount * 0.05), 0.0, 1.0);
                            }
                            
                            color = mix(color, vec3(0.05, 0.06, 0.08), 0.2 * (1.0 - nebulaMask));

                            // Simplified edge fade
                            float edge = 1.0 - length(vUv - 0.5) * 1.4;
                            edge = smoothstep(0.0, 1.0, edge);

                            float finalAlpha = valueShaped * nebulaMask * edge * intensity * (1.0 + effectStrength * 0.2);

                            // Screen-space radial shadow mask (aspect-correct)
                            vec2 screenUv = (vScreenPosition.xy / vScreenPosition.w) * 0.5 + 0.5;
                            vec2 dpNeb = screenUv - shadowCenter;
                            // Use dynamic aspect ratio like the cloud shader
                            dpNeb.x *= resolution.x / max(resolution.y, 1.0);
                            float dMask = length(dpNeb);
                            float mMask = smoothstep(shadowRadius, shadowRadius + max(shadowSoftness, 1e-4), dMask);
                            float darken = 1.0 - shadowStrength * (1.0 - mMask);
                            color *= darken;
                            finalAlpha *= darken;

                            gl_FragColor = vec4(color, finalAlpha);
                        }
                    `;
