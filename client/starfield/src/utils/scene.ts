import type { SceneConfig } from "@/types"

export function generateScene(config: Partial<SceneConfig>): SceneConfig {
  return {
    ...config,
    nebula: {
      ...config.nebula,
    },
    stars: {
      ...config.stars,
    },
  }
}
