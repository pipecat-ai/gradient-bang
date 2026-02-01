export const sunVertexShader = `
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying vec3 vLocalPosition;
  
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vLocalPosition = position;  // Object space (unit sphere: -1 to 1)
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;  // World space
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const sunFragmentShader = `
  precision highp float;
  
  uniform float uIntensity;
  uniform vec3 uCoreColor;
  uniform vec3 uCoronaColor;
  uniform float uScale;
  uniform vec3 uCameraPosition;
  uniform sampler2D uNoiseTexture;
  
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying vec3 vLocalPosition;
  
  void main() {
    // Calculate view direction using world-space positions
    vec3 viewDirection = normalize(uCameraPosition - vWorldPosition);
    vec3 normal = normalize(vNormal);
    
    // Base fresnel - how edge-on is this surface
    float fresnel = 1.0 - abs(dot(viewDirection, normal));
    
    // Create multiple sharp bands at different fresnel thresholds
    float band1 = smoothstep(0.85, 0.95, fresnel);  // Very edge - brightest
    float band2 = smoothstep(0.7, 0.85, fresnel) * (1.0 - band1);  // Second ring
    float band3 = smoothstep(0.5, 0.7, fresnel) * (1.0 - band1 - band2);  // Third ring
    
    // Combine bands with different intensities
    float fresnelGlow = band1 * 1.0 + band2 * 0.6 + band3 * 0.3;
    
    // Sharpen the overall effect
    fresnelGlow = pow(fresnelGlow, 0.7);
    
    // Color: core color for brightest bands, corona for outer
    vec3 finalColor = uCoreColor * band1 + 
                      mix(uCoreColor, uCoronaColor, 0.3) * band2 +
                      uCoronaColor * band3;
    finalColor *= uIntensity;
    
    // Alpha: sharp falloff, only visible at edges
    float alpha = fresnelGlow * uIntensity;
    alpha = clamp(alpha, 0.0, 1.0);
    
    gl_FragColor = vec4(finalColor, alpha);
  }
`
