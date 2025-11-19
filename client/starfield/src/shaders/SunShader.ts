export const sunVertexShader = `
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying vec2 vUv;
  
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPosition = position;
    vUv = uv;
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
  varying vec3 vPosition;
  varying vec2 vUv;
  
  void main() {
    // Calculate view direction
    vec3 viewDirection = normalize(uCameraPosition - vPosition);
    vec3 normal = normalize(vNormal);
    
    // Fresnel-like effect - edges glow more than center when viewed from angle
    float fresnel = 1.0 - abs(dot(viewDirection, normal));
    fresnel = pow(fresnel, 2.0);
    
    // Distance from center of sphere in UV space
    vec2 center = vec2(0.5, 0.5);
    float dist = distance(vUv, center) * 2.0;
    
    // Sample noise from pre-generated texture - static (no animation)
    float noiseScale = 2.0;
    vec2 noiseCoord = vUv * noiseScale;
    float noise = texture2D(uNoiseTexture, noiseCoord).r;
    
    // Add secondary noise layer for more detail
    float noise2 = texture2D(uNoiseTexture, vUv * noiseScale * 2.0).r;
    float combinedNoise = mix(noise, noise2, 0.5);
    
    // Create volumetric layers
    // Core - bright center
    float coreGlow = 1.0 - smoothstep(0.0, 0.4, dist);
    coreGlow = pow(coreGlow, 4.0);
    
    // Fresnel glow - edges
    float fresnelGlow = fresnel * (1.0 - smoothstep(0.3, 1.0, dist));
    fresnelGlow = pow(fresnelGlow, 2.0);
    
    // Corona - outer glow with noise
    float coronaGlow = 1.0 - smoothstep(0.0, 1.0, dist);
    coronaGlow = pow(coronaGlow, 1.5) * (0.8 + combinedNoise * 0.4);
    
    // Combine glows
    float totalGlow = max(coreGlow, max(fresnelGlow * 0.8, coronaGlow * 0.6));
    
    // Color mixing based on intensity
    vec3 finalColor = mix(uCoronaColor, uCoreColor, coreGlow * 0.7);
    finalColor += uCoreColor * fresnelGlow * 0.5;
    finalColor += uCoronaColor * coronaGlow * 0.3;
    finalColor *= uIntensity;
    
    // Alpha with soft edges
    float alpha = totalGlow * uIntensity;
    alpha = clamp(alpha, 0.0, 1.0);
    
    gl_FragColor = vec4(finalColor, alpha);
  }
`
