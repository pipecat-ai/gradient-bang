export const colorAdjustVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const colorAdjustFragmentShader = `
  uniform sampler2D tDiffuse;
  uniform float brightness;
  uniform float contrast;
  uniform float saturation;
  uniform float gamma;
  uniform vec3 shadows;
  uniform vec3 midtones;
  uniform vec3 highlights;
  
  varying vec2 vUv;
  
  // Convert RGB to HSL
  vec3 rgb2hsl(vec3 c) {
    float maxVal = max(max(c.r, c.g), c.b);
    float minVal = min(min(c.r, c.g), c.b);
    float delta = maxVal - minVal;
    float h = 0.0, s = 0.0, l = (maxVal + minVal) * 0.5;
    
    if (delta != 0.0) {
      s = l > 0.5 ? delta / (2.0 - maxVal - minVal) : delta / (maxVal + minVal);
      
      if (maxVal == c.r) {
        h = (c.g - c.b) / delta + (c.g < c.b ? 6.0 : 0.0);
      } else if (maxVal == c.g) {
        h = (c.b - c.r) / delta + 2.0;
      } else {
        h = (c.r - c.g) / delta + 4.0;
      }
      h /= 6.0;
    }
    
    return vec3(h, s, l);
  }
  
  // Convert HSL to RGB
  vec3 hsl2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return c.z + c.y * (rgb - 0.5) * (1.0 - abs(2.0 * c.z - 1.0));
  }
  
  // Apply curves-like adjustment based on luminance
  vec3 applyCurves(vec3 color, float luminance) {
    vec3 adjusted = color;
    
    // Shadows adjustment (low luminance)
    if (luminance < 0.3) {
      float shadowWeight = smoothstep(0.0, 0.3, luminance);
      adjusted = mix(adjusted * shadows, adjusted, shadowWeight);
    }
    
    // Midtones adjustment (medium luminance)
    if (luminance >= 0.3 && luminance <= 0.7) {
      float midWeight = smoothstep(0.3, 0.7, luminance);
      adjusted = mix(adjusted * midtones, adjusted, midWeight);
    }
    
    // Highlights adjustment (high luminance)
    if (luminance > 0.7) {
      float highlightWeight = smoothstep(0.7, 1.0, luminance);
      adjusted = mix(adjusted * highlights, adjusted, highlightWeight);
    }
    
    return adjusted;
  }
  
  void main() {
    vec2 uv = vUv;
    vec3 color = texture(tDiffuse, uv).rgb;
    
    // Calculate luminance
    float luminance = dot(color, vec3(0.299, 0.587, 0.114));
    
    // Apply brightness and contrast
    color = (color - 0.5) * contrast + 0.5 + brightness;
    
    // Apply saturation
    vec3 hsl = rgb2hsl(color);
    hsl.y = clamp(hsl.y * saturation, 0.0, 1.0);
    color = hsl2rgb(hsl);
    
    // Apply curves-like adjustments
    color = applyCurves(color, luminance);
    
    // Apply gamma correction
    color = pow(color, vec3(1.0 / gamma));
    
    // Clamp to valid range
    color = clamp(color, 0.0, 1.0);
    
    gl_FragColor = vec4(color, 1.0);
  }
`;
