import useGameStore from "@/stores/game"
import { waitForStoreCondition } from "@/utils/store"

import type { StarfieldSceneConfig } from "./fx/starfield"

export class GameInstanceManager {
  private _unsubscribe?: () => void
  private _initialized: boolean

  constructor() {
    console.debug("[GAME INSTANCE MANAGER] Instance created")

    this._initialized = false
  }

  async create_instances(): Promise<void> {
    if (this._initialized) return

    console.debug("[GAME INSTANCE MANAGER] Creating")

    // Construct and set instances
    await this._constructStarfield()
    this._constructMiniMap()

    // Setup state subscriber
    this._subscribeToSettings()

    this._initialized = true

    // Resolve promise
    return Promise.resolve()
  }

  private _subscribeToSettings(): void {
    // Prevent multiple subscriptions
    if (this._unsubscribe) {
      console.warn("[GAME INSTANCE MANAGER] Already subscribed to settings")
      return
    }

    // Subscribe only to renderStarfield changes - will only fire when this specific value changes
    this._unsubscribe = useGameStore.subscribe(
      (state) => state.settings.renderStarfield,
      async (renderStarfield) => {
        console.debug(
          `[GAME INSTANCE MANAGER] Starfield setting changed to ${renderStarfield}`
        )
        if (renderStarfield) {
          await this._constructStarfield()
          this.initializeStarfield()
        } else {
          this._destroyStarfield()
        }
      }
    )
  }

  public destroy(): void {
    console.debug("[GAME INSTANCE MANAGER] Destroying")
    this._unsubscribe?.()
  }

  public async initialize(): Promise<void> {
    console.debug("[GAME INSTANCE MANAGER] Initializing")

    // Wait for sector to be populated from server before initializing
    try {
      await waitForStoreCondition(
        useGameStore,
        (state) => state.sector,
        (sector) => sector !== undefined
      )
      console.debug(
        "[GAME INSTANCE MANAGER] Sector ready, proceeding with initialization"
      )
    } catch (error) {
      console.error("[GAME INSTANCE MANAGER] Failed to wait for sector:", error)
      throw error
    }

    await this.initializeStarfield()

    console.debug("[GAME INSTANCE MANAGER] Initialization complete")
  }

  // ----- STARFIELD

  private async _constructStarfield(): Promise<void> {
    console.debug("[GAME INSTANCE MANAGER] Constructing starfield")
    const state = useGameStore.getState()
    if (state.starfieldInstance) {
      state.starfieldInstance.destroy()
    }

    // Lazy load the GalaxyStarfield class
    const { GalaxyStarfield } = await import("./fx/starfield")
    const starfield = new GalaxyStarfield()
    state.setStarfieldInstance(starfield)
  }

  private _destroyStarfield(): void {
    console.debug("[GAME INSTANCE MANAGER] Destroying starfield")
    const state = useGameStore.getState()
    const starfield = state.starfieldInstance
    if (starfield) {
      starfield.destroy()
      state.setStarfieldInstance(undefined)
    }
  }

  public async initializeStarfield(): Promise<void> {
    console.debug("[GAME INSTANCE MANAGER] Initializing starfield")
    const state = useGameStore.getState()
    const starfield = state.starfieldInstance

    if (!state.settings.renderStarfield || !starfield || !state.sector) return
    console.debug(
      "[GAME INSTANCE MANAGER] Initializing starfield scene",
      state.sector?.id.toString()
    )

    await starfield.initializeScene({
      id: state.sector?.id.toString() ?? undefined,
      gameObjects: state.sector?.port
        ? [{ id: "port", type: "port", name: "Port" }]
        : undefined,
      sceneConfig: state.sector?.scene_config as StarfieldSceneConfig,
    })
  }

  // ----- MINIMAP

  private _constructMiniMap(): void {
    // @TODO: implement
  }
}

export default GameInstanceManager
