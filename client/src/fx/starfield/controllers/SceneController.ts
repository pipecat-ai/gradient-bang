import type { SceneManager } from "../managers/SceneManager";
import type { GalaxyStarfieldConfig } from "../constants";

interface SceneControllerHost {
  reloadConfig: (
    config: Partial<GalaxyStarfieldConfig> | null
  ) => Promise<void>;
  onSceneLoading: () => void;
  onSceneReady: (isFirstRender: boolean, sceneId: string | null) => void;
  resolveWhiteFlash: () => HTMLElement | null;
  getSceneManager: () => SceneManager | undefined;
  getCurrentConfig: () => GalaxyStarfieldConfig;
  getCurrentSceneId: () => string | null;
  suspendRendering: () => boolean;
  resumeRendering: (wasRendering: boolean) => void;
}

interface LoadOptions {
  triggerCallbacks?: boolean;
  transition?: boolean;
}

export class SceneController {
  private readonly host: SceneControllerHost;
  private sceneReady: boolean = false;
  private flashHoldStartMs: number = 0;
  private sceneSettleStartMs?: number;
  private isFirstRender: boolean = true;
  private lockedConfig: Partial<GalaxyStarfieldConfig> | null = null;
  private sceneLoadPromise: Promise<void> | null = null;

  private readonly SCENE_SETTLE_DURATION = 150;
  private readonly MIN_FLASH_HOLD_TIME = 300;
  private readonly MAX_FLASH_HOLD_TIME = 5000;

  constructor(host: SceneControllerHost) {
    this.host = host;
  }

  public setLockedConfig(config: Partial<GalaxyStarfieldConfig> | null): void {
    this.lockedConfig = config ? { ...config } : null;
  }

  public isSceneReady(): boolean {
    return this.sceneReady;
  }

  public getFlashHoldStartTime(): number {
    return this.flashHoldStartMs;
  }

  public async loadScene(
    newConfig: Partial<GalaxyStarfieldConfig> | null,
    options: LoadOptions = {}
  ): Promise<void> {
    const { triggerCallbacks = true, transition = false } = options;

    this.sceneReady = false;

    if (triggerCallbacks) {
      this.host.onSceneLoading();
    }

    const whiteFlash = transition ? this.host.resolveWhiteFlash() : null;

    if (transition && whiteFlash) {
      whiteFlash.style.opacity = "1.0";
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
      const flashStartTime = performance.now();

      await this.host.reloadConfig(newConfig);
      await this.waitForSceneReadyState();

      const flashElapsed = performance.now() - flashStartTime;
      const minTimeElapsed = flashElapsed >= this.MIN_FLASH_HOLD_TIME;
      const hasTimedOut = flashElapsed >= this.MAX_FLASH_HOLD_TIME;

      if (!minTimeElapsed && !hasTimedOut) {
        const remainingTime = this.MIN_FLASH_HOLD_TIME - flashElapsed;
        await new Promise((resolve) => setTimeout(resolve, remainingTime));
      }

      if (hasTimedOut) {
        console.warn("[TRANSITION] Flash hold timeout, forcing progression");
      }

      await this.fadeOutWhiteFlash(whiteFlash, 200);
    } else {
      await this.host.reloadConfig(newConfig);
      await this.waitForSceneReadyState();
    }

    if (triggerCallbacks) {
      this.host.onSceneReady(this.isFirstRender, this.host.getCurrentSceneId());
      this.isFirstRender = false;
    }
  }

  public enterFlashPhase(): void {
    this.flashHoldStartMs = performance.now();
    this.sceneReady = false;
    this.host.onSceneLoading();

    const wasRendering = this.host.suspendRendering();
    this.sceneLoadPromise = this.createNewScene()
      .then(() => {
        this.host.onSceneReady(
          this.isFirstRender,
          this.host.getCurrentSceneId()
        );
        this.isFirstRender = false;
      })
      .catch((err) => {
        console.error("[STARFIELD] WARP: Scene loading failed:", err);
        this.sceneReady = true;
      })
      .finally(() => {
        this.host.resumeRendering(wasRendering);
      });

    void this.sceneLoadPromise;
  }

  public async createNewScene(): Promise<void> {
    const sceneManager = this.host.getSceneManager();
    if (!sceneManager) {
      console.warn("[STARFIELD] SceneManager not available");
      return;
    }
    let newConfig: Partial<GalaxyStarfieldConfig> | null = null;

    if (this.lockedConfig) {
      newConfig = this.lockedConfig;
      this.lockedConfig = null;
    } else {
      newConfig = sceneManager.create(this.host.getCurrentConfig());
    }

    await this.loadScene(newConfig, { triggerCallbacks: false, transition: false });
  }

  public dispose(): void {
    this.sceneLoadPromise = null;
    this.lockedConfig = null;
    this.sceneReady = false;
  }

  public markSceneReady(): void {
    this.sceneReady = true;
  }

  private async waitForSceneReadyState(): Promise<void> {
    this.sceneSettleStartMs = performance.now();

    await new Promise<void>((resolve) => {
      const checkSettling = () => {
        const settleElapsed = performance.now() - (this.sceneSettleStartMs || 0);
        if (settleElapsed >= this.SCENE_SETTLE_DURATION) {
          resolve();
        } else {
          requestAnimationFrame(checkSettling);
        }
      };
      checkSettling();
    });

    this.sceneReady = true;
  }

  private async fadeOutWhiteFlash(
    element: HTMLElement,
    duration: number
  ): Promise<void> {
    const fadeStartTime = performance.now();

    await new Promise<void>((resolve) => {
      const fadeOut = () => {
        const fadeElapsed = performance.now() - fadeStartTime;
        const fadeProgress = Math.min(fadeElapsed / duration, 1);
        const easedProgress =
          fadeProgress < 0.5
            ? 2 * fadeProgress * fadeProgress
            : 1 - Math.pow(-2 * fadeProgress + 2, 2) / 2;
        const opacity = Math.max(0, 1 - easedProgress);

        element.style.opacity = opacity.toString();

        if (fadeProgress < 1) {
          requestAnimationFrame(fadeOut);
        } else {
          resolve();
        }
      };
      fadeOut();
    });
  }
}
