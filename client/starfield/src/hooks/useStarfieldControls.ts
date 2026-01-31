import { useControls } from "leva"

import type { StarfieldConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

const IS_DEV = import.meta.env.DEV

/**
 * Hook to determine if Leva controls should be shown.
 * Returns true only when both IS_DEV build flag and debug prop are true.
 */
export function useShowControls(): boolean {
  const debug = useGameStore((state) => state.debug)
  return IS_DEV && debug
}

/**
 * Hook for component config controls with optional Leva UI.
 * Returns config values from store, with Leva controls only in dev+debug mode.
 */
export function useSceneControls<T extends object>(
  name: string,
  configSelector: (config: StarfieldConfig) => T,
  levaSchema: Parameters<typeof useControls>[1]
): T {
  const showControls = useShowControls()
  const configValues = useGameStore((state) =>
    configSelector(state.starfieldConfig)
  )

  const levaValues = useControls(name, showControls ? levaSchema : {})

  return showControls ? (levaValues as unknown as T) : configValues
}
