import * as THREE from "three";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";

export function createNoiseTexture(size: number = 512): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const noise = new ImprovedNoise();
  const z = Math.random() * 1000;
  const scales = [1.5, 4.0, 8.0, 16.0];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = x / size;
      const ny = y / size;

      const r = noise.noise(nx * scales[0], ny * scales[0], z);
      const g = noise.noise(nx * scales[1], ny * scales[1], z + 37.1);
      const b = noise.noise(nx * scales[2], ny * scales[2], z + 71.7);
      const a = noise.noise(nx * scales[3], ny * scales[3], z + 123.4);

      data[idx + 0] = Math.max(
        0,
        Math.min(255, Math.floor((r * 0.5 + 0.5) * 255))
      );
      data[idx + 1] = Math.max(
        0,
        Math.min(255, Math.floor((g * 0.5 + 0.5) * 255))
      );
      data[idx + 2] = Math.max(
        0,
        Math.min(255, Math.floor((b * 0.5 + 0.5) * 255))
      );
      data[idx + 3] = Math.max(
        0,
        Math.min(255, Math.floor((a * 0.5 + 0.5) * 255))
      );
    }
  }

  const tex = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
