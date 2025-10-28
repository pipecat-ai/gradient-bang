import type { GalaxyStarfieldConfig } from "../constants";
import type { SceneManager } from "../managers/SceneManager";

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

interface TransitionOptions extends LoadOptions {
  schedule?: "immediate" | "defer";
}

interface FlashPhaseOptions {
  skipFlash?: boolean;
}

export interface FlashHoldStatus {
  elapsedMs: number;
  meetsMinimumHold: boolean;
  timedOut: boolean;
  remainingToMinimum: number;
}

export class SceneController {
  private readonly host: SceneControllerHost;
  private sceneReady: boolean = false;
  private flashHoldStartMs: number | null = null;
  private sceneSettleStartMs?: number;
  private isFirstRender: boolean = true;
  private lockedConfig: Partial<GalaxyStarfieldConfig> | null = null;

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

  public getFlashHoldStatus(now: number = performance.now()): FlashHoldStatus {
    return this.calculateFlashHoldStatus(this.flashHoldStartMs, now);
  }

  public transitionToScene(
    newConfig: Partial<GalaxyStarfieldConfig> | null,
    options: TransitionOptions = {}
  ): Promise<void> {
    const { schedule = "immediate", ...loadOptions } = options;
    const operation = () => this.performSceneLoad(newConfig, loadOptions);

    return schedule === "defer"
      ? this.runDeferred(operation)
      : operation();
  }

  private async performSceneLoad(
    newConfig: Partial<GalaxyStarfieldConfig> | null,
    options: LoadOptions = {}
  ): Promise<void> {
    const { triggerCallbacks = true, transition = false } = options;

    this.sceneReady = false;

    if (triggerCallbacks) {
      this.host.onSceneLoading();
    }

    const wasRendering = this.host.suspendRendering();
    let renderingResumed = false;
    const resumeRendering = () => {
      if (!renderingResumed) {
        this.host.resumeRendering(wasRendering);
        renderingResumed = true;
      }
    };
    try {
      const whiteFlash = transition ? this.host.resolveWhiteFlash() : null;

      if (transition && whiteFlash) {
        whiteFlash.style.opacity = "1.0";
        const flashStartTime = performance.now();

        await this.host.reloadConfig(newConfig);
        await this.waitForSceneReadyState();
        resumeRendering();

        const holdStatus = this.calculateFlashHoldStatus(flashStartTime);
        if (!holdStatus.meetsMinimumHold && !holdStatus.timedOut) {
          await new Promise((resolve) =>
            setTimeout(resolve, holdStatus.remainingToMinimum)
          );
        }

        if (holdStatus.timedOut) {
          console.warn("[TRANSITION] Flash hold timeout, forcing progression");
        }

        await this.fadeOutWhiteFlash(whiteFlash, 200);
      } else {
        await this.host.reloadConfig(newConfig);
        await this.waitForSceneReadyState();
        resumeRendering();
      }

      if (triggerCallbacks) {
        this.host.onSceneReady(
          this.isFirstRender,
          this.host.getCurrentSceneId()
        );
        this.isFirstRender = false;
      }
    } finally {
      resumeRendering();
    }
  }

  public async enterFlashPhase(
    options: FlashPhaseOptions = {}
  ): Promise<void> {
    const { skipFlash = false } = options;
    this.flashHoldStartMs = performance.now();
    this.sceneReady = false;
    this.host.onSceneLoading();

    const whiteFlash = this.host.resolveWhiteFlash();

    try {
      if (!skipFlash && whiteFlash) {
        whiteFlash.style.opacity = "1.0";
      } else if (skipFlash && whiteFlash) {
        whiteFlash.style.opacity = "0";
      }

      await this.createNewSceneInternal("defer");
    } catch (error) {
      console.error("[STARFIELD] Failed to enter flash phase:", error);
      this.sceneReady = true;
    }
  }

  private async createNewSceneInternal(
    schedule: "immediate" | "defer" = "immediate"
  ): Promise<void> {
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

    await this.transitionToScene(newConfig, {
      triggerCallbacks: false,
      transition: false,
      schedule,
    });
  }

  public dispose(): void {
    this.lockedConfig = null;
    this.sceneReady = false;
  }

  public markSceneReady(): void {
    this.sceneReady = true;
  }

  private calculateFlashHoldStatus(
    startTime: number | null,
    now: number = performance.now()
  ): FlashHoldStatus {
    if (startTime === null) {
      return {
        elapsedMs: 0,
        meetsMinimumHold: false,
        timedOut: false,
        remainingToMinimum: this.MIN_FLASH_HOLD_TIME,
      };
    }

    const elapsedMs = Math.max(0, now - startTime);
    return {
      elapsedMs,
      meetsMinimumHold: elapsedMs >= this.MIN_FLASH_HOLD_TIME,
      timedOut: elapsedMs >= this.MAX_FLASH_HOLD_TIME,
      remainingToMinimum: Math.max(
        0,
        this.MIN_FLASH_HOLD_TIME - elapsedMs
      ),
    };
  }

  private async waitForSceneReadyState(): Promise<void> {
    this.sceneSettleStartMs = performance.now();

    await new Promise<void>((resolve) => {
      const checkSettling = () => {
        const settleElapsed =
          performance.now() - (this.sceneSettleStartMs || 0);
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

  private runDeferred<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      window.setTimeout(() => {
        operation().then(resolve).catch(reject);
      }, 0);
    });
  }
}
