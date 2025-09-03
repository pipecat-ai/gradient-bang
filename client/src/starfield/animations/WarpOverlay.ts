/**
 * Warp overlay effect with screen distortion
 * Renders animated tunnel/warp trails on a 2D canvas overlay
 */

import { type Trail, TrailPool } from "../utils/TrailPool";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Canvas size dimensions */
export interface CanvasSize {
  width: number;
  height: number;
}

/** Performance history entry */
export interface PerformanceEntry {
  frameTime: number;
  timestamp: number;
}

/** Dirty region for optimized rendering */
export interface DirtyRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Warp effect configuration */
export interface WarpEffectConfig {
  intensity: number;
  trailCount: number;
  opacityMultiplier: number;
  adaptiveFrameRate: boolean;
  targetFrameTime: number;
}

/** Trail rendering parameters */
export interface TrailRenderParams {
  centerX: number;
  centerY: number;
  intensity: number;
  phase: string;
  time: number;
}

// ============================================================================
// WARP OVERLAY CLASS
// ============================================================================

/**
 * WarpOverlay Class
 * Manages canvas-based particle effects for warp animations
 */
export class WarpOverlay {
  public canvas: HTMLCanvasElement | null;
  public ctx: CanvasRenderingContext2D | null;
  private trailPool: TrailPool;
  private trails: Trail[];
  private active: boolean;
  private intensity: number;

  // Global opacity multiplier for easy tunnel strength control
  private opacityMultiplier: number;

  // Performance optimization: Gradient caching
  private gradientCache: Map<string, CanvasGradient>;
  private maxCacheSize: number;
  private cacheHits: number;
  private cacheMisses: number;

  // Performance optimization: Cached values (for future use)
  // private _lastPhase: string | null;
  // private _lastIntensity: number;
  // private _lastCanvasSize: CanvasSize;

  // Performance optimization: Canvas clearing optimization
  private _lastRenderTime: number;
  private _renderThreshold: number;
  private _dirtyRegions: DirtyRegion[];
  private _needsFullClear: boolean;

  // Performance optimization: Adaptive frame rate
  private _adaptiveFrameRate: boolean;
  private _performanceHistory: PerformanceEntry[];
  private _maxPerformanceHistory: number;
  private _targetFrameTime: number;
  private _minFrameTime: number;
  private _maxFrameTime: number;

  // Performance optimization: Pre-computed constants
  private _goldenAngle: number;
  // private _pi2: number; // Reserved for future use
  // private _piHalf: number; // Reserved for future use

  constructor() {
    this.canvas = document.getElementById(
      "warpOverlay"
    ) as HTMLCanvasElement | null;
    this.ctx = this.canvas?.getContext("2d") || null;
    this.trailPool = new TrailPool({ initialSize: 400 }); // Initialize with 400 trails
    this.trails = [];
    this.active = false;
    this.intensity = 0;

    // Global opacity multiplier for easy tunnel strength control
    this.opacityMultiplier = 3.0;

    // Performance optimization: Gradient caching
    this.gradientCache = new Map();
    this.maxCacheSize = 50;
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Performance optimization: Cached values (commented out - for future use)
    // this._lastPhase = null;
    // this._lastIntensity = -1;
    // this._lastCanvasSize = { width: 0, height: 0 };

    // Performance optimization: Canvas clearing optimization
    this._lastRenderTime = 0;
    this._renderThreshold = 16; // ~60fps threshold
    this._dirtyRegions = [];
    this._needsFullClear = true;

    // Performance optimization: Adaptive frame rate
    this._adaptiveFrameRate = true;
    this._performanceHistory = [];
    this._maxPerformanceHistory = 30; // Track last 30 frames
    this._targetFrameTime = 16.67; // Target 60fps
    this._minFrameTime = 8.33; // Max 120fps
    this._maxFrameTime = 33.33; // Min 30fps

    // Performance optimization: Pre-computed constants
    this._goldenAngle = Math.PI * (3 - Math.sqrt(5));
    // this._pi2 = Math.PI * 2; // Reserved for future use
    // this._piHalf = Math.PI / 2; // Reserved for future use

    this.setupCanvas();
  }

  /**
   * Setup canvas properties and blending
   */
  private setupCanvas(): void {
    if (!this.canvas || !this.ctx) {
      console.warn("WarpOverlay: Canvas or context not available");
      return;
    }

    // Set up canvas for proper blending with the 3D scene
    this.setupCanvasBlending();

    // Resize canvas to match window
    this.resizeCanvas();

    // Add resize listener
    window.addEventListener("resize", () => this.resizeCanvas());
  }

  /**
   * Set up canvas for proper blending with the 3D scene
   */
  private setupCanvasBlending(): void {
    if (!this.ctx) return;

    this.ctx.globalCompositeOperation = "screen";
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * Resize canvas to match window dimensions
   */
  private resizeCanvas(): void {
    if (!this.canvas) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    // Only resize if dimensions changed
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      // this._lastCanvasSize = { width, height }; // For future use
      this._needsFullClear = true;

      // Update canvas styles
      this.canvas.style.position = "absolute";
      this.canvas.style.top = "0";
      this.canvas.style.left = "0";
      this.canvas.style.pointerEvents = "none";
      this.canvas.style.zIndex = "10";
    }
  }

  /**
   * Start warp effect with specified intensity
   */
  public start(intensity: number = 1.0): void {
    this.active = true;
    this.intensity = Math.max(0, Math.min(1, intensity));
    this.generateTrails();
    console.debug(`WarpOverlay: Started with intensity ${this.intensity}`);
  }

  /**
   * Stop warp effect
   */
  public stop(): void {
    this.active = false;
    this.intensity = 0;
    this.clearTrails();
    this.clearCanvas();
    console.debug("WarpOverlay: Stopped");
  }

  /**
   * Update warp effect intensity
   */
  public setIntensity(intensity: number): void {
    this.intensity = Math.max(0, Math.min(1, intensity));
  }

  /**
   * Generate trail objects for the effect
   */
  private generateTrails(): void {
    this.clearTrails();

    const trailCount = Math.floor(50 + this.intensity * 150); // 50-200 trails based on intensity

    for (let i = 0; i < trailCount; i++) {
      const trail = this.trailPool.get();
      if (trail) {
        this.initializeTrail(trail, i, trailCount);
        this.trails.push(trail);
      }
    }
  }

  /**
   * Initialize a trail with random properties
   */
  private initializeTrail(
    trail: Trail,
    index: number,
    _totalTrails: number
  ): void {
    // Use golden angle for even distribution
    trail.baseAngle = index * this._goldenAngle;
    trail.angle = trail.baseAngle;
    trail.radius = 20 + Math.random() * 100;
    trail.speed = 0.5 + Math.random() * 2.0;
    trail.length = 0;
    trail.maxLength = 10 + Math.random() * 40;
    trail.opacity = 0.3 + Math.random() * 0.7;
    trail.thickness = 1 + Math.random() * 3;
    trail.delay = Math.random() * 1000;
    trail.rotationSpeed = (Math.random() - 0.5) * 0.02;
    trail.distance = 0;
    trail.layer = Math.floor(Math.random() * 3);
  }

  /**
   * Clear all trails
   */
  private clearTrails(): void {
    for (const trail of this.trails) {
      this.trailPool.reset(trail);
    }
    this.trails = [];
  }

  /**
   * Update and render the warp effect
   */
  public update(phase: string, intensity: number): void {
    if (!this.active || !this.ctx || !this.canvas) return;

    // Performance check
    const now = performance.now();
    if (now - this._lastRenderTime < this._renderThreshold) {
      return; // Skip frame for performance
    }

    this.setIntensity(intensity);
    this._lastRenderTime = now;

    // Clear canvas
    this.clearCanvas();

    // Update and render trails
    this.updateTrails(phase);
    this.renderTrails();

    // Update performance tracking
    this.updatePerformanceTracking(performance.now() - now);
  }

  /**
   * Update trail positions and properties
   */
  private updateTrails(_phase: string): void {
    const centerX = this.canvas!.width / 2;
    const centerY = this.canvas!.height / 2;

    for (const trail of this.trails) {
      // Update trail animation based on phase
      trail.angle += trail.rotationSpeed;
      trail.radius += trail.speed * this.intensity;
      trail.length = Math.min(trail.length + trail.speed, trail.maxLength);

      // Reset trails that have moved too far
      if (trail.radius > Math.max(centerX, centerY) * 2) {
        this.resetTrail(trail);
      }
    }
  }

  /**
   * Render all trails to canvas
   */
  private renderTrails(): void {
    if (!this.ctx) return;

    this.ctx.save();
    this.ctx.globalAlpha = this.intensity * this.opacityMultiplier;

    for (const trail of this.trails) {
      this.renderTrail(trail);
    }

    this.ctx.restore();
  }

  /**
   * Render individual trail
   */
  private renderTrail(trail: Trail): void {
    if (!this.ctx || !this.canvas) return;

    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;

    // Calculate trail position
    const x = centerX + Math.cos(trail.angle) * trail.radius;
    const y = centerY + Math.sin(trail.angle) * trail.radius;

    // Create gradient for trail
    const gradient = this.getTrailGradient(x, y, trail);

    // Draw trail
    this.ctx.save();
    this.ctx.globalAlpha = trail.opacity * this.intensity;
    this.ctx.strokeStyle = gradient;
    this.ctx.lineWidth = trail.thickness;
    this.ctx.lineCap = "round";

    this.ctx.beginPath();
    this.ctx.moveTo(x, y);

    // Draw trail length
    const endX = x + Math.cos(trail.angle + Math.PI) * trail.length;
    const endY = y + Math.sin(trail.angle + Math.PI) * trail.length;
    this.ctx.lineTo(endX, endY);

    this.ctx.stroke();
    this.ctx.restore();
  }

  /**
   * Get gradient for trail (with caching)
   */
  private getTrailGradient(x: number, y: number, trail: Trail): CanvasGradient {
    const cacheKey = `${Math.floor(x / 10)}_${Math.floor(y / 10)}_${
      trail.layer
    }`;

    let gradient = this.gradientCache.get(cacheKey);
    if (gradient) {
      this.cacheHits++;
      return gradient;
    }

    this.cacheMisses++;

    // Create new gradient
    gradient = this.ctx!.createRadialGradient(x, y, 0, x, y, trail.length);

    // Layer-based colors
    switch (trail.layer) {
      case 0:
        gradient.addColorStop(0, "rgba(100, 200, 255, 1)");
        gradient.addColorStop(1, "rgba(100, 200, 255, 0)");
        break;
      case 1:
        gradient.addColorStop(0, "rgba(255, 150, 100, 1)");
        gradient.addColorStop(1, "rgba(255, 150, 100, 0)");
        break;
      default:
        gradient.addColorStop(0, "rgba(200, 100, 255, 1)");
        gradient.addColorStop(1, "rgba(200, 100, 255, 0)");
    }

    // Cache gradient
    if (this.gradientCache.size >= this.maxCacheSize) {
      // Remove oldest entry
      const firstKey = this.gradientCache.keys().next().value;
      if (firstKey !== undefined) {
        this.gradientCache.delete(firstKey);
      }
    }
    this.gradientCache.set(cacheKey, gradient);

    return gradient;
  }

  /**
   * Reset trail to starting position
   */
  private resetTrail(trail: Trail): void {
    trail.radius = 20 + Math.random() * 50;
    trail.length = 0;
    trail.angle = trail.baseAngle + (Math.random() - 0.5) * 0.5;
  }

  /**
   * Clear canvas efficiently
   */
  private clearCanvas(): void {
    if (!this.ctx || !this.canvas) return;

    if (this._needsFullClear || this._dirtyRegions.length === 0) {
      // Full clear
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._needsFullClear = false;
    } else {
      // Clear only dirty regions
      for (const region of this._dirtyRegions) {
        this.ctx.clearRect(region.x, region.y, region.width, region.height);
      }
    }

    this._dirtyRegions = [];
  }

  /**
   * Update performance tracking
   */
  private updatePerformanceTracking(frameTime: number): void {
    if (!this._adaptiveFrameRate) return;

    this._performanceHistory.push({
      frameTime,
      timestamp: performance.now(),
    });

    // Limit history size
    if (this._performanceHistory.length > this._maxPerformanceHistory) {
      this._performanceHistory.shift();
    }

    // Adjust render threshold based on performance
    const avgFrameTime =
      this._performanceHistory.reduce(
        (sum, entry) => sum + entry.frameTime,
        0
      ) / this._performanceHistory.length;

    if (avgFrameTime > this._targetFrameTime * 1.5) {
      // Performance is poor, reduce frame rate
      this._renderThreshold = Math.min(
        this._maxFrameTime,
        this._renderThreshold * 1.1
      );
    } else if (avgFrameTime < this._targetFrameTime * 0.8) {
      // Performance is good, increase frame rate
      this._renderThreshold = Math.max(
        this._minFrameTime,
        this._renderThreshold * 0.95
      );
    }
  }

  /**
   * Check if warp overlay is active
   */
  public isActive(): boolean {
    return this.active;
  }

  /**
   * Get current intensity
   */
  public getIntensity(): number {
    return this.intensity;
  }

  /**
   * Set opacity multiplier
   */
  public setOpacityMultiplier(multiplier: number): void {
    this.opacityMultiplier = Math.max(0, multiplier);
  }

  /**
   * Get performance statistics
   */
  public getPerformanceStats(): {
    cacheHitRate: number;
    averageFrameTime: number;
    currentThreshold: number;
    trailCount: number;
  } {
    const totalCacheRequests = this.cacheHits + this.cacheMisses;
    const cacheHitRate =
      totalCacheRequests > 0 ? this.cacheHits / totalCacheRequests : 0;

    const avgFrameTime =
      this._performanceHistory.length > 0
        ? this._performanceHistory.reduce(
            (sum, entry) => sum + entry.frameTime,
            0
          ) / this._performanceHistory.length
        : 0;

    return {
      cacheHitRate,
      averageFrameTime: avgFrameTime,
      currentThreshold: this._renderThreshold,
      trailCount: this.trails.length,
    };
  }

  /**
   * Set adaptive frame rate enabled
   */
  public setAdaptiveFrameRate(enabled: boolean): void {
    this._adaptiveFrameRate = enabled;
    if (!enabled) {
      this._renderThreshold = this._targetFrameTime;
    }
  }

  /**
   * Clear gradient cache
   */
  public clearCache(): void {
    this.gradientCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * Resize canvas to new dimensions
   */
  public resize(width: number, height: number): void {
    if (!this.canvas) return;

    this.canvas.width = width;
    this.canvas.height = height;
    //this._lastCanvasSize = { width, height };
    this._needsFullClear = true;
    this.clearCache(); // Clear cache on resize
  }

  /**
   * Get canvas element
   */
  public getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /**
   * Get rendering context
   */
  public getContext(): CanvasRenderingContext2D | null {
    return this.ctx;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.stop();
    this.trailPool.dispose();
    this.clearCache();

    // Remove event listeners
    window.removeEventListener("resize", () => this.resizeCanvas());

    this.canvas = null;
    this.ctx = null;

    console.debug("WarpOverlay: Disposed");
  }

  /**
   * Get trail pool statistics
   */
  public getTrailPoolStats(): any {
    return this.trailPool.getStats();
  }

  /**
   * Force full canvas clear on next render
   */
  public forceFullClear(): void {
    this._needsFullClear = true;
  }

  /**
   * Set canvas visibility
   */
  public setVisible(visible: boolean): void {
    if (this.canvas) {
      this.canvas.style.display = visible ? "block" : "none";
    }
  }
}
