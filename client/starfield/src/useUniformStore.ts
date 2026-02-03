import { create } from "zustand"

export type UniformValue<T = unknown> = { value: T }

export type UniformRegistration<T = unknown> = {
  uniform: UniformValue<T>
  initial?: T
  meta?: Record<string, unknown>
}

export type RegisterUniformOptions<T = unknown> = {
  initial?: T
  meta?: Record<string, unknown>
}

interface UniformStore {
  uniformRegistry: Map<string, UniformRegistration>
  registerUniform: <T>(
    key: string,
    uniform: UniformValue<T>,
    options?: RegisterUniformOptions<T>
  ) => void
  removeUniform: (key: string) => void
  getUniform: <T = unknown>(key: string) => UniformRegistration<T> | undefined
  /** Set uniform by key (includes map lookup) */
  setUniform: <T = unknown>(key: string, value: T) => void
  /** Update uniform directly (no map lookup - use when you already have the registration) */
  updateUniform: <T>(reg: UniformRegistration<T>, value: T) => void
}

/**
 * Uniform Store - manages shader uniform references for animation
 *
 * This store is intentionally separate from useGameStore to avoid
 * Immer freezing the uniform objects, which need to remain mutable.
 *
 * Usage:
 *   // Register a uniform (typically in a component's useEffect)
 *   registerUniform("myUniform", material.uniforms.myValue, { initial: 1.0 })
 *
 *   // Set uniform by key (includes map lookup)
 *   setUniform("myUniform", newValue)
 *
 *   // For hot paths (useFrame), get once and update directly:
 *   const reg = getUniform("myUniform")
 *   if (reg) updateUniform(reg, newValue)  // No map lookup!
 *
 *   // Unregister on cleanup
 *   removeUniform("myUniform")
 */
export const useUniformStore = create<UniformStore>((set, get) => ({
  uniformRegistry: new Map(),

  registerUniform: (key, uniform, options) =>
    set((state) => {
      const uniformRegistry = new Map(state.uniformRegistry)
      uniformRegistry.set(key, {
        uniform,
        initial: options?.initial,
        meta: options?.meta,
      })
      return { uniformRegistry }
    }),

  removeUniform: (key) =>
    set((state) => {
      if (!state.uniformRegistry.has(key)) {
        return state
      }
      const uniformRegistry = new Map(state.uniformRegistry)
      uniformRegistry.delete(key)
      return { uniformRegistry }
    }),

  getUniform: <T = unknown>(key: string) => {
    return get().uniformRegistry.get(key) as UniformRegistration<T> | undefined
  },

  setUniform: <T = unknown>(key: string, value: T) => {
    const reg = get().uniformRegistry.get(key) as
      | UniformRegistration<T>
      | undefined
    if (reg) {
      reg.uniform.value = value
    }
  },

  // Direct update - no map lookup, maximum performance for hot paths
  updateUniform: <T>(reg: UniformRegistration<T>, value: T) => {
    reg.uniform.value = value
  },
}))
