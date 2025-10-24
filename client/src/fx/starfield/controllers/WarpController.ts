import { type GalaxyStarfieldConfig } from "../constants";
import type { GameObjectBaseConfig, WarpOptions } from "../types";

type ReadyCallback = (task: WarpRequest) => void;
type QueueUpdateCallback = (length: number) => void;
type IdleCallback = () => void;
type ShakeCallback = (active: boolean) => void;
type CooldownGetter = () => number;
type DelayGetter = () => number;
type WarpingGetter = () => boolean;

export interface WarpRequest {
  options: WarpOptions;
  preparedConfig: Partial<GalaxyStarfieldConfig> | null;
  gameObjects: GameObjectBaseConfig[];
  sceneId: string;
}

interface WarpControllerParams {
  getQueueDelayMs: DelayGetter;
  getCooldownMs: CooldownGetter;
  isCurrentlyWarping: WarpingGetter;
  onQueueUpdate: QueueUpdateCallback;
  onQueueIdle: IdleCallback;
  setShakeActive: ShakeCallback;
  handleCinematic: ReadyCallback;
  handleBypass: (task: WarpRequest) => Promise<void>;
}

export class WarpController {
  private readonly params: WarpControllerParams;
  private queue: WarpRequest[] = [];
  private isProcessingQueue = false;
  private queueDelayTimer: number | null = null;
  private cooldownTimer: number | null = null;
  private shouldShakeDuringQueue = false;

  constructor(params: WarpControllerParams) {
    this.params = params;
  }

  public request(task: WarpRequest): void {
    if (this.params.isCurrentlyWarping() || this.isProcessingQueue) {
      this.enqueue(task);
      return;
    }

    if (this.cooldownTimer !== null) {
      this.enqueue(task);
      if (!this.isProcessingQueue) {
        this.shouldShakeDuringQueue = true;
        this.processQueue();
      }
      return;
    }

    if (task.options.bypassAnimation) {
      void this.params.handleBypass(task);
      return;
    }

    this.startCinematic(task);
  }

  public queueLength(): number {
    return this.queue.length;
  }

  public isCooldownActive(): boolean {
    return this.cooldownTimer !== null;
  }

  public isProcessing(): boolean {
    return this.isProcessingQueue || this.queueDelayTimer !== null;
  }

  public clearCooldown(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  public clearQueue(): void {
    this.queue = [];
    if (this.queueDelayTimer !== null) {
      clearTimeout(this.queueDelayTimer);
      this.queueDelayTimer = null;
    }
    this.isProcessingQueue = false;
    if (this.shouldShakeDuringQueue) {
      this.shouldShakeDuringQueue = false;
      this.params.setShakeActive(false);
    }
    this.params.onQueueUpdate(0);
    this.params.onQueueIdle();
  }

  public dispose(): void {
    if (this.queueDelayTimer !== null) {
      clearTimeout(this.queueDelayTimer);
      this.queueDelayTimer = null;
    }
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.queue = [];
    this.isProcessingQueue = false;
    this.shouldShakeDuringQueue = false;
    this.params.setShakeActive(false);
    this.params.onQueueUpdate(0);
    this.params.onQueueIdle();
  }

  public notifyWarpComplete(): void {
    if (this.queue.length > 0) {
      this.shouldShakeDuringQueue = true;
      this.params.setShakeActive(true);
      this.params.onQueueUpdate(this.queue.length);
    } else {
      this.shouldShakeDuringQueue = false;
      this.params.setShakeActive(false);
    }

    const cooldownMs = this.params.getCooldownMs();
    if (cooldownMs > 0) {
      this.cooldownTimer = window.setTimeout(() => {
        this.cooldownTimer = null;
      }, cooldownMs);
    }

    this.processQueue();
  }

  private enqueue(task: WarpRequest): void {
    this.queue.push(task);
    this.params.onQueueUpdate(this.queue.length);
  }

  private processQueue(): void {
    if (this.queue.length === 0) {
      this.isProcessingQueue = false;
      if (this.shouldShakeDuringQueue) {
        this.shouldShakeDuringQueue = false;
        this.params.setShakeActive(false);
      }
      this.params.onQueueIdle();
      return;
    }

    this.isProcessingQueue = true;
    if (this.shouldShakeDuringQueue) {
      this.params.setShakeActive(true);
    }

    const delayMs = this.params.getQueueDelayMs();
    if (this.queueDelayTimer !== null) {
      clearTimeout(this.queueDelayTimer);
    }
    this.queueDelayTimer = window.setTimeout(() => {
      this.queueDelayTimer = null;
      const task = this.queue.shift();
      this.params.onQueueUpdate(this.queue.length);
      if (!task) {
        this.processQueue();
        return;
      }

      void this.params.handleBypass(task).then(() => {
        this.processQueue();
      });
    }, delayMs);
  }

  private startCinematic(task: WarpRequest): void {
    this.params.handleCinematic(task);
  }
}
