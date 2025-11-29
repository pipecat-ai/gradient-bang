/**
 * Shared GLSL noise utilities for shaders
 * Extracted from various Shadertoy implementations
 */

/**
 * Hash function for pseudo-random noise generation
 * From: https://www.shadertoy.com/view/4sc3z2
 */
export const glslHash33 = `
vec3 hash33(vec3 p3)
{
  p3 = fract(p3 * vec3(.1031,.11369,.13787));
  p3 += dot(p3, p3.yxz+19.19);
  return -1.0 + 2.0 * fract(vec3((p3.x + p3.y)*p3.z, (p3.x+p3.z)*p3.y, (p3.y+p3.z)*p3.x));
}
`

/**
 * Simplex noise function
 * From: https://www.shadertoy.com/view/MttSz2
 */
export const glslSimplexNoise = `
float simplexNoise(vec3 p)
{
  const float K1 = 0.333333333;
  const float K2 = 0.166666667;
  
  vec3 i = floor(p + (p.x + p.y + p.z) * K1);
  vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
  
  vec3 e = step(vec3(0.0), d0 - d0.yzx);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  
  vec3 d1 = d0 - (i1 - 1.0 * K2);
  vec3 d2 = d0 - (i2 - 2.0 * K2);
  vec3 d3 = d0 - (1.0 - 3.0 * K2);
  
  vec4 h = max(0.6 - vec4(dot(d0, d0), dot(d1, d1), dot(d2, d2), dot(d3, d3)), 0.0);
  vec4 n = h * h * h * h * vec4(dot(d0, hash33(i)), dot(d1, hash33(i + i1)), dot(d2, hash33(i + i2)), dot(d3, hash33(i + 1.0)));
  
  return dot(vec4(31.316), n);
}
`

/**
 * Fractal Brownian Motion with 3D noise
 * Layered noise for more complex procedural patterns
 */
export const glslFBm3 = `
float fBm3(in vec3 p)
{
  float f = 0.0;
  float scale = 5.0;
  p = mod(p, scale);
  float amp = 0.75;
  
  for (int i = 0; i < 5; i++)
  {
    f += simplexNoise(p * scale) * amp;
    amp *= 0.5;
    scale *= 2.0;
  }
  return min(f, 1.0);
}
`

/**
 * Advanced Perlin/Simplex noise functions
 * From: https://www.shadertoy.com/view/4dBcWy
 */
export const glslMod289 = `
vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}
`

export const glslPermute = `
vec4 permute(vec4 x) {
  return mod289(((x*34.0)+1.0)*x);
}
`

export const glslTaylorInvSqrt = `
vec4 taylorInvSqrt(vec4 r)
{
  return 1.79284291400159 - 0.85373472095314 * r;
}
`

/**
 * High-quality 3D Simplex noise
 * From: https://www.shadertoy.com/view/4dBcWy
 */
export const glslSnoise = `
float snoise(vec3 v)
{ 
  const vec2 C = vec2(0.1666666666666667, 0.3333333333333333);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  // First corner
  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 = v - i + dot(i, C.xxx) ;

  // Other corners
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  // Permutations
  i = mod289(i); 
  vec4 p = permute( permute( permute( 
    i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) 
    + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

  // Gradients: 7x7 points over a square, mapped onto an octahedron.
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );

  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);

  // Normalise gradients
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  // Mix final noise value
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), 
    dot(p2,x2), dot(p3,x3) ) );
}
`

/**
 * Complete noise utility bundle with all required functions
 * Use this when you need hash33 + simplexNoise + fBm3
 */
export const glslNoiseUtilsBasic =
  glslHash33 + "\n" + glslSimplexNoise + "\n" + glslFBm3

/**
 * Complete advanced noise utility bundle
 * Use this when you need mod289 + permute + taylorInvSqrt + snoise
 */
export const glslNoiseUtilsAdvanced =
  glslMod289 + "\n" + glslPermute + "\n" + glslTaylorInvSqrt + "\n" + glslSnoise
