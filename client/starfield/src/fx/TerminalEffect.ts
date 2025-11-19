export const terminalVertexShader = `
              varying vec2 vUv;
              void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
              }
            `

export const terminalFragmentShader = `
              uniform sampler2D tDiffuse;
              uniform float time;
              uniform vec2 resolution;
              uniform float intensity;
              uniform float cellSize;
              uniform float characterDensity;
              uniform float contrast;
              uniform float scanlineIntensity;
              uniform float scanlineFrequency;
              uniform bool scanlinesEnabled;
              uniform vec3 terminalColorPrimary;
              uniform vec3 terminalColorSecondary;
              
              varying vec2 vUv;
              
              // Hash function for random character generation
              float hash(vec2 p) {
                return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
              }
              
              // Generate ASCII-like characters
              float getCharacter(vec2 cellUV, float brightness) {
                vec2 charPos = cellUV * 8.0; // 8x8 character grid
                vec2 grid = floor(charPos);
                vec2 charUV = fract(charPos);
                
                // Hash based on cell position and brightness level
                float charIndex = hash(grid + floor(brightness * 8.0));
                
                // Generate different character patterns based on brightness
                float char = 0.0;
                
                if (brightness > 0.8) {
                  // Dense characters for bright areas (█, ▓)
                  char = step(0.2, charUV.x) * step(0.2, charUV.y) * 
                         (1.0 - step(0.8, charUV.x)) * (1.0 - step(0.8, charUV.y));
                } else if (brightness > 0.6) {
                  // Medium characters (▒, ░)
                  char = step(0.3, mod(charUV.x + charUV.y + charIndex, 0.6));
                } else if (brightness > 0.4) {
                  // Sparse characters (., :, ;)
                  char = step(0.7, hash(charUV + charIndex)) * 
                         step(distance(charUV, vec2(0.5)), 0.2);
                } else if (brightness > 0.2) {
                  // Very sparse (single pixels)
                  char = step(0.9, hash(charUV + charIndex)) * 
                         step(distance(charUV, vec2(0.5)), 0.1);
                }
                
                return char * step(characterDensity, hash(grid * 0.1 + time * 0.001));
              }
              
              void main() {
                vec2 screenUV = vUv;
                
                // Sample the actual rendered scene
                vec3 sceneColor = texture2D(tDiffuse, screenUV).rgb;
                
                // Get cell coordinates
                vec2 cellCoord = floor(screenUV * resolution / cellSize);
                vec2 cellUV = fract(screenUV * resolution / cellSize);
                
                // Convert scene to brightness
                float brightness = dot(sceneColor, vec3(0.299, 0.587, 0.114));
                brightness = pow(brightness * contrast, 1.5);
                
                // Generate terminal character
                float terminalChar = getCharacter(cellUV, brightness);
                
                // Terminal colors (configurable)
                vec3 terminalColor = mix(
                  terminalColorPrimary,   // Primary color (default: green)
                  terminalColorSecondary, // Secondary color (default: amber)
                  brightness * 0.5
                );
                
                // Apply terminal effect
                vec3 finalColor = sceneColor;
                
                if (intensity > 0.0) {
                  if (terminalChar > 0.0) {
                    // Replace scene with terminal characters
                    finalColor = mix(sceneColor, terminalColor * terminalChar, intensity);
                  } else {
                    // Dark areas become black in terminal mode
                    finalColor = mix(sceneColor, vec3(0.0), intensity * 0.3);
                  }
                }
                
                // Add configurable scan lines (only if enabled)
                if (scanlinesEnabled) {
                  float scanline = sin(screenUV.y * resolution.y * scanlineFrequency) * scanlineIntensity + (1.0 - scanlineIntensity);
                  finalColor *= scanline;
                }
                
                gl_FragColor = vec4(finalColor, 1.0);
              }
            `
