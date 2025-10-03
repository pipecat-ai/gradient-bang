export const sharpenVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const sharpenFragmentShader = `
  uniform sampler2D tDiffuse;
  uniform vec2 resolution;
  uniform float intensity;
  uniform float radius;
  uniform float threshold;
  
  varying vec2 vUv;
  
  void main() {
    vec2 texelSize = 1.0 / resolution;
    vec2 uv = vUv;
    
    // Sample the center pixel
    vec3 center = texture(tDiffuse, uv).rgb;
    
    // Sample neighboring pixels for blur calculation
    vec3 blur = vec3(0.0);
    float totalWeight = 0.0;
    
    // Create a simple box blur kernel
    float r = radius;
    for (float x = -r; x <= r; x += 1.0) {
      for (float y = -r; y <= r; y += 1.0) {
        vec2 offset = vec2(x, y) * texelSize;
        vec3 sampleColor = texture(tDiffuse, uv + offset).rgb;
        float weight = 1.0 / ((2.0 * r + 1.0) * (2.0 * r + 1.0));
        blur += sampleColor * weight;
        totalWeight += weight;
      }
    }
    blur /= totalWeight;
    
    // Calculate the difference between center and blurred
    vec3 diff = center - blur;
    
    // Apply threshold to avoid sharpening noise
    float diffMagnitude = length(diff);
    if (diffMagnitude < threshold) {
      diff = vec3(0.0);
    }
    
    // Apply sharpening by adding the difference back
    vec3 sharpened = center + diff * intensity;
    
    // Clamp to prevent oversaturation
    sharpened = clamp(sharpened, 0.0, 1.0);
    
    gl_FragColor = vec4(sharpened, 1.0);
  }
`;
