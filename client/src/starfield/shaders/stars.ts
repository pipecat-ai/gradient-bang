export const starsVertexShader = `
                        attribute float size;
                        attribute float twinklePhase;
                        attribute float twinkleSpeed;
                        varying vec3 vColor;
                        varying float vFogDepth;
                        varying float vTwinkle;
                        varying float vSpeed;
                        uniform float time;
                        uniform float warpProgress;
                        uniform float shakeIntensity;
                        uniform float twinkleIntensity;
                        uniform float globalTwinkleSpeed;
                        uniform float tunnelEffect;

                        uniform float forwardOffset;
                        uniform float motionBlur;

                        void main() {
                            vColor = color;

                            // Calculate twinkle using global speed multiplier and per-star variation
                            float twinkle = sin(time * globalTwinkleSpeed * twinkleSpeed + twinklePhase) * 0.5 + 0.5;
                            twinkle = twinkle * twinkle; // Make twinkle more dramatic
                            vTwinkle = mix(1.0, twinkle, twinkleIntensity);

                            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

                            // Enhanced warp effect with tunneling
                            float effectStrength = max(warpProgress, tunnelEffect);
                            vSpeed = effectStrength;

                            if (effectStrength > 0.0) {
                                float distFromCenter = length(mvPosition.xy);

                                // Create spiral tunnel effect
                                float angle = atan(mvPosition.y, mvPosition.x);
                                float spiralFactor = effectStrength * 2.0;
                                angle += spiralFactor * distFromCenter * 0.01;

                                // Stretch stars towards camera with motion trail effect
                                float speed = effectStrength * 30.0;
                                mvPosition.z -= speed * distFromCenter * 0.08;

                                // Add subtle Z-axis motion blur by elongating in Z direction
                                float motionStretch = 1.0 + effectStrength * 2.0;

                                // Create barrel distortion during warp
                                float distortion = 1.0 + effectStrength * 0.8;
                                float r = length(mvPosition.xy);
                                r = pow(r, distortion);
                                mvPosition.x = r * cos(angle);
                                mvPosition.y = r * sin(angle);

                                // Scale based on warp progress
                                mvPosition.xy *= mix(1.0, 0.3, effectStrength);
                            }

                            // Shake effect
                            if (shakeIntensity > 0.0) {
                                mvPosition.xy += vec2(
                                    sin(time * 50.0 + position.x * 0.1) * shakeIntensity,
                                    cos(time * 47.0 + position.y * 0.1) * shakeIntensity
                                );
                            }

                            vFogDepth = -mvPosition.z;
                            // Accumulated forward offset (idle/shake)
                            mvPosition.z += forwardOffset;
                            gl_Position = projectionMatrix * mvPosition;

                            // Size calculation with distance attenuation
                            float distanceSize = size * (200.0 / -mvPosition.z);
                            distanceSize *= vTwinkle; // Apply twinkle to size

                            // Enlarge and stretch during warp for motion effect
                            distanceSize *= (1.0 + effectStrength * 3.0);

                            // Add subtle elongation based on speed
                            if (effectStrength > 0.2) {
                                distanceSize *= (1.0 + effectStrength * 2.0);
                            }

                            // Clamp and pixelate
                            gl_PointSize = floor(distanceSize + 0.5);
                            gl_PointSize = clamp(gl_PointSize, 2.0, 16.0); // Minimum 2px for motion blur visibility
                        }
                    `;

export const starsFragmentShader = `
                        varying vec3 vColor;
                        varying float vFogDepth;
                        varying float vTwinkle;
                        varying float vSpeed;
                        uniform float fogNear;
                        uniform float fogFar;
                        uniform float warpProgress;
                        uniform float tunnelEffect;
                        uniform float minPointDepth;
                        uniform float motionBlur;
                        #define NEAR_FADE_END_MULT 1.2

                        void main() {
                            // Cull points that are too close to the camera
                            if (vFogDepth < minPointDepth) {
                                discard;
                            }
                            // Create elongated shape during warp for motion blur effect
                            vec2 coord = gl_PointCoord - vec2(0.5);
                            float effectStrength = max(warpProgress, tunnelEffect);

                            // Stretch the star shape based on speed (only if motion blur enabled)
                            if (motionBlur > 0.5 && effectStrength > 0.2) {
                                coord.y *= (1.0 - effectStrength * 0.5); // Elongate vertically
                            }

                            if (abs(coord.x) > 0.5 || abs(coord.y) > 0.5) {
                                discard;
                            }

                            // Apply fog
                            float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);

                            // Enhance brightness during warp
                            float brightness = mix(1.0, 3.0, effectStrength);

                            // Color shift based on speed (blue shift when approaching)
                            vec3 speedColor = vColor;
                            if (effectStrength > 0.0) {
                                // Blue shift for approaching stars
                                speedColor = mix(vColor, vec3(0.5, 0.8, 1.0), effectStrength * 0.5);
                                // Add slight red trails for receding effect
                                float trailEffect = smoothstep(0.3, 0.5, gl_PointCoord.y);
                                speedColor = mix(speedColor, vec3(1.0, 0.7, 0.5), trailEffect * effectStrength * 0.3);
                            }

                            vec3 finalColor = speedColor * vTwinkle * brightness;

                            // Reduce fog during warp for better visibility
                            finalColor = mix(finalColor, vec3(0.0), fogFactor * (1.0 - effectStrength * 0.5));

                            // Gentle near fade instead of hard pop near the camera
                            float nearFade = smoothstep(0.0, minPointDepth * NEAR_FADE_END_MULT, vFogDepth);
                            finalColor *= nearFade;

                            // Add glow during intense warp
                            if (effectStrength > 0.5) {
                                float glow = 1.0 - length(coord) * 2.0;
                                finalColor += vec3(0.3, 0.5, 0.8) * glow * effectStrength;
                            }

                            gl_FragColor = vec4(finalColor, nearFade);
                        }
                    `;
