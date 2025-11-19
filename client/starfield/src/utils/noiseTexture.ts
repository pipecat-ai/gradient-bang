import * as THREE from "three"

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
