import * as THREE from "three"

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
 * @param iterations - Number of octaves (default: 5)
 */
export const createFBm3 = (iterations: number = 5) => `
float fBm3(in vec3 p)
{
  float f = 0.0;
  float scale = 5.0;
  p = mod(p, scale);
  float amp = 0.75;
  
  for (int i = 0; i < ${iterations}; i++)
  {
    f += simplexNoise(p * scale) * amp;
    amp *= 0.5;
    scale *= 2.0;
  }
  return min(f, 1.0);
}
`

// Keep the original for backwards compatibility
export const glslFBm3 = createFBm3(5)

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
 * Complete noise utility bundle with configurable fBm3 iterations
 * @param fBm3Iterations - Number of octaves for fBm3 (default: 5)
 */
export const createNoiseUtilsBasic = (fBm3Iterations: number = 5) =>
  glslHash33 + "\n" + glslSimplexNoise + "\n" + createFBm3(fBm3Iterations)

/**
 * Complete advanced noise utility bundle
 * Use this when you need mod289 + permute + taylorInvSqrt + snoise
 */
export const glslNoiseUtilsAdvanced =
  glslMod289 + "\n" + glslPermute + "\n" + glslTaylorInvSqrt + "\n" + glslSnoise

/**
 * Simple 3D simplex noise implementation
 * Based on the shader noise used in the nebula effect
 */
function simplexNoise3D(x: number, y: number, z: number): number {
  const C = [1.0 / 6.0, 1.0 / 3.0]

  // Skew the input space to determine which simplex cell we're in
  const s = (x + y + z) * C[1]
  const i = Math.floor(x + s)
  const j = Math.floor(y + s)
  const k = Math.floor(z + s)

  const t = (i + j + k) * C[0]
  const X0 = i - t
  const Y0 = j - t
  const Z0 = k - t
  const x0 = x - X0
  const y0 = y - Y0
  const z0 = z - Z0

  // Determine which simplex we are in
  let i1, j1, k1
  let i2, j2, k2

  if (x0 >= y0) {
    if (y0 >= z0) {
      i1 = 1
      j1 = 0
      k1 = 0
      i2 = 1
      j2 = 1
      k2 = 0
    } else if (x0 >= z0) {
      i1 = 1
      j1 = 0
      k1 = 0
      i2 = 1
      j2 = 0
      k2 = 1
    } else {
      i1 = 0
      j1 = 0
      k1 = 1
      i2 = 1
      j2 = 0
      k2 = 1
    }
  } else {
    if (y0 < z0) {
      i1 = 0
      j1 = 0
      k1 = 1
      i2 = 0
      j2 = 1
      k2 = 1
    } else if (x0 < z0) {
      i1 = 0
      j1 = 1
      k1 = 0
      i2 = 0
      j2 = 1
      k2 = 1
    } else {
      i1 = 0
      j1 = 1
      k1 = 0
      i2 = 1
      j2 = 1
      k2 = 0
    }
  }

  const x1 = x0 - i1 + C[0]
  const y1 = y0 - j1 + C[0]
  const z1 = z0 - k1 + C[0]
  const x2 = x0 - i2 + 2.0 * C[0]
  const y2 = y0 - j2 + 2.0 * C[0]
  const z2 = z0 - k2 + 2.0 * C[0]
  const x3 = x0 - 1.0 + 3.0 * C[0]
  const y3 = y0 - 1.0 + 3.0 * C[0]
  const z3 = z0 - 1.0 + 3.0 * C[0]

  // Permutation
  const perm = (x: number): number => {
    const p = Math.floor(x) & 255
    const hash = [
      151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
      140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247,
      120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177,
      33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165,
      71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211,
      133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25,
      63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196,
      135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217,
      226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206,
      59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248,
      152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22,
      39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218,
      246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
      81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
      184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
      222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
    ]
    return hash[p]
  }

  // Calculate gradient indices for the four corners
  const gi0 = perm(i + perm(j + perm(k))) % 12
  const gi1 = perm(i + i1 + perm(j + j1 + perm(k + k1))) % 12
  const gi2 = perm(i + i2 + perm(j + j2 + perm(k + k2))) % 12
  const gi3 = perm(i + 1 + perm(j + 1 + perm(k + 1))) % 12

  // Calculate the contribution from the four corners
  let n0 = 0,
    n1 = 0,
    n2 = 0,
    n3 = 0

  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0
  if (t0 > 0) {
    t0 *= t0
    n0 = t0 * t0 * (gi0 * x0 + gi0 * y0 + gi0 * z0)
  }

  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1
  if (t1 > 0) {
    t1 *= t1
    n1 = t1 * t1 * (gi1 * x1 + gi1 * y1 + gi1 * z1)
  }

  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2
  if (t2 > 0) {
    t2 *= t2
    n2 = t2 * t2 * (gi2 * x2 + gi2 * y2 + gi2 * z2)
  }

  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3
  if (t3 > 0) {
    t3 *= t3
    n3 = t3 * t3 * (gi3 * x3 + gi3 * y3 + gi3 * z3)
  }

  return 32.0 * (n0 + n1 + n2 + n3)
}

/**
 * Creates a precomputed noise texture for the nebula shader
 * This improves performance by avoiding real-time noise calculation
 *
 * @param size - Size of the texture (will be size x size)
 * @returns THREE.DataTexture containing the noise data
 */
export function createNoiseTexture(size: number = 512): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4

      // Generate multi-octave noise for more interesting patterns
      const scale = 0.02
      let value = 0
      let amplitude = 1
      let frequency = 1

      // 3 octaves of noise
      for (let oct = 0; oct < 3; oct++) {
        value +=
          amplitude *
          simplexNoise3D(
            x * scale * frequency,
            y * scale * frequency,
            oct * 10.0
          )
        amplitude *= 0.5
        frequency *= 2.0
      }

      // Normalize to 0-1 range
      value = (value + 1.0) * 0.5
      value = Math.max(0, Math.min(1, value))

      const byte = Math.floor(value * 255)

      // Store in all channels (grayscale)
      data[i] = byte
      data[i + 1] = byte
      data[i + 2] = byte
      data[i + 3] = 255
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.needsUpdate = true

  return texture
}

/**
 * Creates a simpler value noise texture for effects like sun corona
 * Uses value noise which is faster to compute than simplex noise
 *
 * @param size - Size of the texture (will be size x size)
 * @returns THREE.DataTexture containing the noise data
 */
export function createValueNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)

  // Simple 2D noise generation (value noise)
  const random = (x: number, y: number) => {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    return n - Math.floor(n)
  }

  const smoothNoise = (x: number, y: number) => {
    const fractX = x - Math.floor(x)
    const fractY = y - Math.floor(y)

    const x1 = Math.floor(x)
    const y1 = Math.floor(y)
    const x2 = x1 + 1
    const y2 = y1 + 1

    const value1 = random(x1, y1)
    const value2 = random(x2, y1)
    const value3 = random(x1, y2)
    const value4 = random(x2, y2)

    const i1 = value1 * (1 - fractX) + value2 * fractX
    const i2 = value3 * (1 - fractX) + value4 * fractX

    return i1 * (1 - fractY) + i2 * fractY
  }

  // Generate multi-octave noise
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const x = i / size
      const y = j / size

      // Multiple octaves for more interesting noise
      let value =
        smoothNoise(x * 4, y * 4) * 0.5 +
        smoothNoise(x * 8, y * 8) * 0.25 +
        smoothNoise(x * 16, y * 16) * 0.125 +
        smoothNoise(x * 32, y * 32) * 0.0625

      value = Math.max(0, Math.min(1, value)) // Clamp to 0-1

      const index = (i + j * size) * 4
      const colorValue = Math.floor(value * 255)
      data[index] = colorValue // R
      data[index + 1] = colorValue // G
      data[index + 2] = colorValue // B
      data[index + 3] = 255 // A
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.needsUpdate = true

  return texture
}

// ---------------------------------------------------------------------------
// JS port of the GLSL hash33 + simplexNoise used by the tunnel shader.
// Must match the GLSL exactly so the pre-baked texture looks identical to the
// old per-pixel computation.
// ---------------------------------------------------------------------------

function fract(x: number): number {
  return x - Math.floor(x)
}

function glslMod(a: number, b: number): number {
  return a - b * Math.floor(a / b)
}

function hash33(px: number, py: number, pz: number): [number, number, number] {
  // p3 = fract(p3 * vec3(.1031,.11369,.13787))
  let x = fract(px * 0.1031)
  let y = fract(py * 0.11369)
  let z = fract(pz * 0.13787)

  // p3 += dot(p3, p3.yxz + 19.19)
  const d = x * y + y * x + z * z + 19.19 * (x + y + z)
  // More precisely: dot(p3, p3.yxz+19.19) = p3.x*(p3.y+19.19) + p3.y*(p3.x+19.19) + p3.z*(p3.z+19.19)
  const dot = x * (y + 19.19) + y * (x + 19.19) + z * (z + 19.19)
  x += dot
  y += dot
  z += dot

  // return -1.0 + 2.0 * fract(vec3((p3.x+p3.y)*p3.z, (p3.x+p3.z)*p3.y, (p3.y+p3.z)*p3.x))
  return [
    -1.0 + 2.0 * fract((x + y) * z),
    -1.0 + 2.0 * fract((x + z) * y),
    -1.0 + 2.0 * fract((y + z) * x),
  ]
}

function glslSimplexNoiseJS(px: number, py: number, pz: number): number {
  const K1 = 0.333333333
  const K2 = 0.166666667

  // vec3 i = floor(p + (p.x + p.y + p.z) * K1)
  const s = (px + py + pz) * K1
  const ix = Math.floor(px + s)
  const iy = Math.floor(py + s)
  const iz = Math.floor(pz + s)

  // vec3 d0 = p - (i - (i.x + i.y + i.z) * K2)
  const t = (ix + iy + iz) * K2
  const d0x = px - (ix - t)
  const d0y = py - (iy - t)
  const d0z = pz - (iz - t)

  // vec3 e = step(vec3(0.0), d0 - d0.yzx)
  const ex = d0x - d0y >= 0.0 ? 1.0 : 0.0
  const ey = d0y - d0z >= 0.0 ? 1.0 : 0.0
  const ez = d0z - d0x >= 0.0 ? 1.0 : 0.0

  // vec3 i1 = e * (1.0 - e.zxy)
  const i1x = ex * (1.0 - ez)
  const i1y = ey * (1.0 - ex)
  const i1z = ez * (1.0 - ey)

  // vec3 i2 = 1.0 - e.zxy * (1.0 - e)
  const i2x = 1.0 - ez * (1.0 - ex)
  const i2y = 1.0 - ex * (1.0 - ey)
  const i2z = 1.0 - ey * (1.0 - ez)

  // vec3 d1 = d0 - (i1 - K2)
  const d1x = d0x - (i1x - K2)
  const d1y = d0y - (i1y - K2)
  const d1z = d0z - (i1z - K2)

  // vec3 d2 = d0 - (i2 - 2.0 * K2)
  const d2x = d0x - (i2x - 2.0 * K2)
  const d2y = d0y - (i2y - 2.0 * K2)
  const d2z = d0z - (i2z - 2.0 * K2)

  // vec3 d3 = d0 - (1.0 - 3.0 * K2)
  const d3x = d0x - (1.0 - 3.0 * K2)
  const d3y = d0y - (1.0 - 3.0 * K2)
  const d3z = d0z - (1.0 - 3.0 * K2)

  // vec4 h = max(0.6 - vec4(dot(d0,d0), dot(d1,d1), dot(d2,d2), dot(d3,d3)), 0.0)
  let h0 = Math.max(0.0, 0.6 - (d0x * d0x + d0y * d0y + d0z * d0z))
  let h1 = Math.max(0.0, 0.6 - (d1x * d1x + d1y * d1y + d1z * d1z))
  let h2 = Math.max(0.0, 0.6 - (d2x * d2x + d2y * d2y + d2z * d2z))
  let h3 = Math.max(0.0, 0.6 - (d3x * d3x + d3y * d3y + d3z * d3z))

  // h * h * h * h (h^4)
  h0 = h0 * h0 * h0 * h0
  h1 = h1 * h1 * h1 * h1
  h2 = h2 * h2 * h2 * h2
  h3 = h3 * h3 * h3 * h3

  // hash33 for each corner
  const g0 = hash33(ix, iy, iz)
  const g1 = hash33(ix + i1x, iy + i1y, iz + i1z)
  const g2 = hash33(ix + i2x, iy + i2y, iz + i2z)
  const g3 = hash33(ix + 1.0, iy + 1.0, iz + 1.0)

  // dot products
  const n0 = h0 * (d0x * g0[0] + d0y * g0[1] + d0z * g0[2])
  const n1 = h1 * (d1x * g1[0] + d1y * g1[1] + d1z * g1[2])
  const n2 = h2 * (d2x * g2[0] + d2y * g2[1] + d2z * g2[2])
  const n3 = h3 * (d3x * g3[0] + d3y * g3[1] + d3z * g3[2])

  // return dot(vec4(31.316), n)
  return 31.316 * (n0 + n1 + n2 + n3)
}

/**
 * Creates a tileable noise texture for the tunnel shader.
 * Samples 3-octave fBM noise on a cylinder so the U axis (angle)
 * tiles seamlessly. V axis (time scroll) tiles via RepeatWrapping.
 * Uses a JS port of the exact GLSL hash33 + simplexNoise for identical output.
 *
 * @param size - Texture dimensions (size x size). Default 256.
 * @returns THREE.DataTexture with noise in all channels
 */
export function createTunnelNoiseTexture(size = 256): THREE.DataTexture {
  const TAU = Math.PI * 2
  const circleRadius = 6.0 // matches default tunnelDepth=0.4: 1.5 * 0.4 * 10
  const vRange = 5.0 // noise-Z range to bake into V dimension

  const data = new Uint8Array(size * size * 4)

  for (let vy = 0; vy < size; vy++) {
    for (let ux = 0; ux < size; ux++) {
      const u = ux / size
      const v = vy / size

      // Sample noise on a cylinder (tiles in U because the circle closes)
      const rawX = Math.cos(u * TAU) * circleRadius
      const rawY = Math.sin(u * TAU) * circleRadius
      const rawZ = v * vRange

      // Replicate GLSL fBm3: mod(p, 5.0) then 3 octaves
      const px = glslMod(rawX, 5.0)
      const py = glslMod(rawY, 5.0)
      const pz = glslMod(rawZ, 5.0)

      let f = 0.0
      let scale = 5.0
      let amp = 0.75

      for (let i = 0; i < 3; i++) {
        f += glslSimplexNoiseJS(px * scale, py * scale, pz * scale) * amp
        amp *= 0.5
        scale *= 2.0
      }

      // Match GLSL fBm3: return min(f, 1.0) — no lower clamp
      const value = Math.max(0, Math.min(1, f))
      const byte = Math.floor(value * 255)

      const idx = (vy * size + ux) * 4
      data[idx] = byte
      data[idx + 1] = byte
      data[idx + 2] = byte
      data[idx + 3] = 255
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true

  return texture
}

/**
 * Camera shake utilities for smooth, organic motion
 * Based on Perlin noise for natural-looking shake patterns
 */

/**
 * Fade function for smooth Perlin interpolation
 * Uses Perlin's improved smoothstep function
 */
export function fade(t: number): number {
  return t * t * t * (t * (6 * t - 15) + 10)
}

/**
 * Generates a 1D Perlin noise array for camera shake
 * Pre-computes noise values for efficient runtime performance
 *
 * @param length - Number of cycles (frequency * duration in seconds)
 * @param step - Number of samples (FPS * duration in seconds)
 * @returns Array of noise values between -1 and 1
 */
export function makePNoise1D(length: number, step: number): number[] {
  const noise: number[] = []
  const gradients: number[] = []

  // Generate random gradients for each integer point
  for (let i = 0; i < length; i++) {
    gradients[i] = Math.random() * 2 - 1
  }

  // Interpolate noise values at each step
  for (let t = 0; t < step; t++) {
    const x = ((length - 1) / (step - 1)) * t

    const i0 = Math.floor(x)
    const i1 = i0 + 1

    const g0 = gradients[i0]
    const g1 = gradients[i1] !== undefined ? gradients[i1] : gradients[i0]

    const u0 = x - i0
    const u1 = u0 - 1

    const n0 = g0 * u0
    const n1 = g1 * u1

    // Use fade function for smooth interpolation
    noise.push(n0 * (1 - fade(u0)) + n1 * fade(u0))
  }

  return noise
}
