/**
 * Wait for a specified number of animation frames.
 * Useful for letting React/Three.js settle after initialization.
 */
export function waitFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    if (count <= 0) {
      resolve()
      return
    }
    const tick = (remaining: number) => {
      if (remaining <= 0) {
        resolve()
        return
      }
      requestAnimationFrame(() => tick(remaining - 1))
    }
    tick(count)
  })
}
