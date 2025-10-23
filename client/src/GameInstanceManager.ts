import { preloadAllSounds } from "@/hooks/usePlaySound";
import useGameStore from "@stores/game";

export class GameInstanceManager {
  private _unsubscribe?: () => void;
  private _initialized: boolean;

  constructor() {
    console.debug("[GAME INSTANCE MANAGER] Instance created");

    this._initialized = false;
  }

  async initialize(): Promise<void> {
    console.debug("[GAME INSTANCE MANAGER] Initializing");

    // Construct and set instances
    this._constructStarfield();
    this._constructMiniMap();
    this._constructFrame();

    await preloadAllSounds();

    // Initialize and await
    // await this.initializeAndAwait();

    // Setup state subscriber
    this._subscribeToSettings();

    this._initialized = true;

    // Resolve promise
    return Promise.resolve();
  }

  private _subscribeToSettings(): void {
    if (!this._initialized) return;

    // Subscribe to setting changes
    this._unsubscribe = useGameStore.subscribe((state, prevState) => {
      console.debug("[GAME INSTANCE MANAGER] Settings changed");

      if (
        state.settings.renderStarfield !== prevState.settings.renderStarfield
      ) {
        if (state.settings.renderStarfield) {
          this._constructStarfield();
        } else {
          this._destroyStarfield();
        }
      }
    });
  }

  public destroy(): void {
    console.debug("[GAME INSTANCE MANAGER] Destroying");
    this._unsubscribe?.();
  }

  // ----- STARFIELD

  private _constructStarfield(): void {
    console.debug("[GAME INSTANCE MANAGER] Constructing starfield");
    // @TODO: implement
    // const starfield = new GalaxyStarfield();
    // useGameStore.setStarfieldInstance(starfield));
  }

  private _destroyStarfield(): void {
    console.debug("[GAME INSTANCE MANAGER] Destroying starfield");
    const state = useGameStore.getState();
    const starfield = state.starfieldInstance;
    if (starfield) {
      starfield.destroy();
      state.setStarfieldInstance(undefined);
    }
  }

  // ----- MINIMAP

  private _constructMiniMap(): void {
    console.debug("[GAME INSTANCE MANAGER] Constructing minimap");
    // @TODO: implement
  }

  // ----- FRAME

  private _constructFrame(): void {
    console.debug("[GAME INSTANCE MANAGER] Constructing frame");
    // @TODO: implement
  }
}

export default GameInstanceManager;
