/**
 * Warp overlay effect with screen distortion
 * Renders animated tunnel/warp trails on a 2D canvas overlay
 */

import { type Trail, TrailPool, type TrailPoolStats } from "../utils/TrailPool";

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
  private _pi2: number;

  // Performance optimization: Trigonometric lookup tables
  private _sinCache: Map<number, number>;
  private _cosCache: Map<number, number>;
  private _trigCacheSize: number;
  private _trigCachePrecision: number;

  // Canvas center and radius calculations
  private centerX: number;
  private centerY: number;
  private maxRadius: number;

  constructor() {
    // Try to find existing canvas first
    this.canvas = document.getElementById(
      "warpOverlay"
    ) as HTMLCanvasElement | null;

    // If canvas doesn't exist, create it
    if (!this.canvas) {
      console.warn(
        "WarpOverlay: Canvas 'warpOverlay' not found, creating new canvas"
      );
      this.canvas = document.createElement("canvas");
      this.canvas.id = "warpOverlay";
      document.body.appendChild(this.canvas);
    }

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
    this._pi2 = Math.PI * 2;

    // Performance optimization: Trigonometric lookup tables
    this._sinCache = new Map();
    this._cosCache = new Map();
    this._trigCacheSize = 1000; // Cache size for trig functions
    this._trigCachePrecision = 0.001; // Precision for cache keys

    // Canvas center and radius calculations
    this.centerX = 0;
    this.centerY = 0;
    this.maxRadius = 0;

    this.setupCanvas();

    // Ensure canvas is visible and properly positioned
    if (this.canvas) {
      this.canvas.style.display = "block";
      this.canvas.style.visibility = "visible";
    }
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

    // Add resize listener with debouncing
    let resizeTimeout: number;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(() => {
        requestAnimationFrame(() => this.resizeCanvas());
      }, 100);
    });
  }

  /**
   * Set up canvas for proper blending with the 3D scene
   */
  private setupCanvasBlending(): void {
    if (!this.ctx) return;

    // Use screen blending for proper light effects
    this.ctx.globalCompositeOperation = "screen";
    this.ctx.imageSmoothingEnabled = false;

    // Ensure proper alpha handling
    this.ctx.globalAlpha = 1.0;
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

      // Update center coordinates and max radius
      this.centerX = width / 2;
      this.centerY = height / 2;
      this.maxRadius = Math.sqrt(
        this.centerX * this.centerX + this.centerY * this.centerY
      );

      this._needsFullClear = true;

      // Update canvas styles - ensure it's positioned over the 3D scene
      this.canvas.style.position = "absolute";
      this.canvas.style.top = "0";
      this.canvas.style.left = "0";
      this.canvas.style.pointerEvents = "none";
      this.canvas.style.zIndex = "1000"; // Higher z-index to ensure it's on top
      this.canvas.style.mixBlendMode = "screen"; // CSS blend mode as backup

      // Clear gradient cache when canvas size changes
      this.clearCache();
    }
  }

  /**
   * Activate warp effect
   */
  public activate(): void {
    this.active = true;
    if (this.canvas) {
      this.canvas.classList.add("active");
    }

    // Reset trail pool and get fresh trails
    this.trailPool.resetAll();
    this.trails = [];

    // Generate spinning vortex trails for tunnel effect using object pool
    const trailCount = 400; // More trails for denser tunnel

    for (let i = 0; i < trailCount; i++) {
      const trail = this.trailPool.get();
      if (trail) {
        const angle = i * this._goldenAngle; // Spiral distribution
        const radius = Math.sqrt(i / trailCount) * this._pi2; // Expanding radius

        // Initialize trail properties
        trail.baseAngle = angle;
        trail.angle = angle;
        trail.radius = radius;
        trail.speed = 2 + Math.random() * 5;
        trail.length = 0;
        trail.maxLength = 200 + Math.random() * 600; // Longer trails for tunnel
        trail.opacity = Math.random() * 0.8 + 0.2;
        trail.thickness = Math.random() * 1.5 + 0.5;
        trail.delay = i * 0.05; // Faster staggered appearance
        trail.rotationSpeed = 0.5 + Math.random() * 0.5; // Much faster rotation
        trail.distance = 5 + Math.random() * 30; // Start closer to center
        trail.layer = Math.floor(Math.random() * 3); // Multiple layers for depth

        this.trails.push(trail);
      }
    }

    console.debug("WarpOverlay: Activated");
  }

  /**
   * Deactivate warp effect
   */
  public deactivate(): void {
    this.active = false;
    if (this.canvas) {
      this.canvas.classList.remove("active");
    }

    // Return all trails to the pool when deactivating
    if (this.trails.length > 0) {
      this.trailPool.resetAll();
      this.trails = [];
    }

    console.debug("WarpOverlay: Deactivated");
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
        this.initializeTrail(trail, i);
        this.trails.push(trail);
      }
    }
  }

  /**
   * Initialize a trail with random properties
   */
  private initializeTrail(trail: Trail, index: number): void {
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
   * Update and render the warp effect (main method - matches JS version)
   */
  public update(
    phase: string,
    phaseProgress: number,
    deltaSeconds: number
  ): void {
    // Call the full update method for consistent behavior
    this.updateFull(phase, phaseProgress, deltaSeconds);
  }

  /**
   * Main update method with full rendering logic (from JS version)
   */
  public updateFull(
    phase: string,
    phaseProgress: number,
    deltaSeconds: number
  ): void {
    const startTime = performance.now();

    if (!this.active && this.intensity <= 0) return;

    // Performance optimization: Skip render if too soon
    if (this.shouldSkipRender()) return;

    const dt = Math.max(0, deltaSeconds || 0.016);
    const dtFrames = dt * 60.0; // preserve existing visual tuning

    // Update intensity based on phase
    if (this.active) {
      if (phase === "CLIMAX") {
        this.intensity = Math.min(1.5, this.intensity + 3.0 * dt);
      } else if (phase === "BUILDUP") {
        this.intensity = Math.min(1, this.intensity + 0.9 * dt);
      } else if (phase === "CHARGING") {
        this.intensity = Math.min(0.5, this.intensity + 0.6 * dt);
      } else {
        this.intensity = Math.min(0.3, this.intensity + 0.3 * dt);
      }
    } else {
      this.intensity = Math.max(0, this.intensity - 1.2 * dt);
    }

    // Clear canvas with optimization
    this.clearCanvasOptimized();

    // Early-out when effect is visually negligible to save CPU
    if (this.intensity < 0.005) {
      return;
    }

    // Create screen bending effect at edges with batched operations
    if (this.intensity > 0.3) {
      // Draw distortion rings with cached gradients
      const ringCount = Math.floor(5 + this.intensity * 5);

      // Batch all distortion ring operations
      this.ctx!.save();
      for (let i = 1; i <= ringCount; i++) {
        const gradient = this.createDistortionRingGradient(
          i,
          ringCount,
          this.intensity
        );
        this.ctx!.fillStyle = gradient;
        this.ctx!.fillRect(0, 0, this.canvas!.width, this.canvas!.height);
      }
      this.ctx!.restore();
    }

    // Create strong vignette for tunnel effect with cached gradient
    const vignetteGradient = this.createVignetteGradient(phase, this.intensity);
    this.ctx!.fillStyle = vignetteGradient;
    this.ctx!.fillRect(0, 0, this.canvas!.width, this.canvas!.height);

    // Draw warp trails with optimized calculations and batched operations
    this.ctx!.save(); // Batch trail operations

    this.trails.forEach((trail) => {
      // Delay trail appearance for staggered effect
      if (phaseProgress * 100 < trail.delay) return;

      // Skip trails with very low opacity (conservative culling)
      if (trail.opacity * this.intensity < 0.001) return;

      const speedMultiplier =
        phase === "CLIMAX" ? 3 : phase === "BUILDUP" ? 2 : 1;
      trail.length = Math.min(
        trail.maxLength,
        trail.length + trail.speed * this.intensity * speedMultiplier * dtFrames
      );

      const startRadius = Math.max(0, 20 * (1 - this.intensity));
      const endRadius = startRadius + trail.length;

      // Skip trails that are completely off-screen
      if (endRadius > this.maxRadius * 2) return;

      if (endRadius > startRadius && endRadius < this.maxRadius * 2) {
        // Cache trigonometric calculations using optimized functions
        const cosAngle = this.cachedCos(trail.angle);
        const sinAngle = this.cachedSin(trail.angle);

        const x1 = this.centerX + cosAngle * startRadius;
        const y1 = this.centerY + sinAngle * startRadius;
        // const x2 = this.centerX + cosAngle * endRadius; // Unused, keeping for reference
        // const y2 = this.centerY + sinAngle * endRadius; // Unused, keeping for reference

        // Bend trails at edges for distortion effect
        const bendFactor = Math.min(
          1,
          this.optimizedPow(endRadius / this.maxRadius, 2)
        ); // Use optimized pow
        const bendAmount = phase === "CLIMAX" ? 1.0 : 0.5;
        const bendAngle =
          trail.angle + bendFactor * bendAmount * this.intensity;
        const x2Bent = this.centerX + this.cachedCos(bendAngle) * endRadius;
        const y2Bent = this.centerY + this.cachedSin(bendAngle) * endRadius;

        // Check for finite values before creating gradient
        if (
          isFinite(x1) &&
          isFinite(y1) &&
          isFinite(x2Bent) &&
          isFinite(y2Bent)
        ) {
          const gradient = this.ctx!.createLinearGradient(
            x1,
            y1,
            x2Bent,
            y2Bent
          );

          if (phase === "CLIMAX") {
            gradient.addColorStop(
              0,
              `rgba(255, 255, 255, ${
                trail.opacity * this.intensity * this.opacityMultiplier
              })`
            );
            gradient.addColorStop(
              0.3,
              `rgba(200, 220, 255, ${
                trail.opacity * 0.8 * this.intensity * this.opacityMultiplier
              })`
            );
            gradient.addColorStop(
              0.7,
              `rgba(150, 200, 255, ${
                trail.opacity * 0.5 * this.intensity * this.opacityMultiplier
              })`
            );
            gradient.addColorStop(1, "rgba(100, 150, 255, 0)");
          } else {
            gradient.addColorStop(
              0,
              `rgba(150, 200, 255, ${
                trail.opacity * this.intensity * this.opacityMultiplier
              })`
            );
            gradient.addColorStop(
              0.3,
              `rgba(255, 255, 255, ${
                trail.opacity * 0.8 * this.intensity * this.opacityMultiplier
              })`
            );
            gradient.addColorStop(
              0.7,
              `rgba(100, 150, 255, ${
                trail.opacity * 0.5 * this.intensity * this.opacityMultiplier
              })`
            );
            gradient.addColorStop(1, "rgba(50, 100, 255, 0)");
          }

          this.ctx!.strokeStyle = gradient;
          this.ctx!.lineWidth = trail.thickness * (1 + this.intensity * 0.5);
          this.ctx!.beginPath();
          this.ctx!.moveTo(x1, y1);
          this.ctx!.lineTo(x2Bent, y2Bent);
          this.ctx!.stroke();
        }
      }

      // Reset trail when it goes off screen
      if (endRadius > this.maxRadius * 1.5) {
        trail.length = 0;
        trail.speed = 3 + Math.random() * 7;
        trail.maxLength = 300 + Math.random() * 500;
        // Note: Trail object is reused from pool, no need to return to pool here
      }
    });

    this.ctx!.restore(); // End batch trail operations

    // Add center vortex/pinhole effect with cached gradient
    if (this.intensity > 0.3) {
      const vortexGradient = this.createVortexGradient(this.intensity);
      this.ctx!.fillStyle = vortexGradient;
      this.ctx!.fillRect(0, 0, this.canvas!.width, this.canvas!.height);
    }

    // Add center glow during warp with cached gradient
    const centerGlowGradient = this.createCenterGlowGradient(
      phase,
      this.intensity
    );
    this.ctx!.fillStyle = centerGlowGradient;
    this.ctx!.fillRect(0, 0, this.canvas!.width, this.canvas!.height);

    // Performance tracking
    const frameTime = performance.now() - startTime;
    this.updateAdaptiveFrameRate(frameTime);
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
   * Optimized canvas clearing with dirty region tracking
   */
  private clearCanvasOptimized(): void {
    if (!this.ctx || !this.canvas) return;

    // Always clear the entire canvas to ensure transparency
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._needsFullClear = false;
    this._dirtyRegions = [];
  }

  /**
   * Check if we should skip this render frame for performance
   */
  private shouldSkipRender(): boolean {
    const now = performance.now();
    if (now - this._lastRenderTime < this._renderThreshold) {
      return true; // Skip render if too soon
    }
    this._lastRenderTime = now;
    return false;
  }

  /**
   * Update adaptive frame rate based on performance
   */
  private updateAdaptiveFrameRate(frameTime: number): void {
    if (!this._adaptiveFrameRate) return;

    // Add frame time to history
    this._performanceHistory.push({
      frameTime,
      timestamp: performance.now(),
    });

    if (this._performanceHistory.length > this._maxPerformanceHistory) {
      this._performanceHistory.shift();
    }

    // Calculate average frame time
    const avgFrameTime =
      this._performanceHistory.reduce(
        (sum, entry) => sum + entry.frameTime,
        0
      ) / this._performanceHistory.length;

    // Adjust render threshold based on performance
    if (avgFrameTime > this._targetFrameTime * 1.2) {
      // Performance is poor, increase threshold (lower fps)
      this._renderThreshold = Math.min(
        this._maxFrameTime,
        this._renderThreshold * 1.1
      );
    } else if (avgFrameTime < this._targetFrameTime * 0.8) {
      // Performance is good, decrease threshold (higher fps)
      this._renderThreshold = Math.max(
        this._minFrameTime,
        this._renderThreshold * 0.95
      );
    }
  }

  /**
   * Cached trigonometric functions for better performance
   */
  private cachedSin(angle: number): number {
    const key = Math.round(angle / this._trigCachePrecision);
    let value = this._sinCache.get(key);
    if (value === undefined) {
      value = Math.sin(angle);
      if (this._sinCache.size >= this._trigCacheSize) {
        // Clear cache if too large
        this._sinCache.clear();
      }
      this._sinCache.set(key, value);
    }
    return value;
  }

  private cachedCos(angle: number): number {
    const key = Math.round(angle / this._trigCachePrecision);
    let value = this._cosCache.get(key);
    if (value === undefined) {
      value = Math.cos(angle);
      if (this._cosCache.size >= this._trigCacheSize) {
        // Clear cache if too large
        this._cosCache.clear();
      }
      this._cosCache.set(key, value);
    }
    return value;
  }

  /**
   * Optimized math operations
   */
  private optimizedPow(base: number, exponent: number): number {
    // Use multiplication for common cases instead of Math.pow
    if (exponent === 2) return base * base;
    if (exponent === 3) return base * base * base;
    if (exponent === 0.5) return Math.sqrt(base);
    return Math.pow(base, exponent);
  }

  /**
   * Clear trigonometric caches
   */
  private clearTrigCaches(): void {
    this._sinCache.clear();
    this._cosCache.clear();
  }

  /**
   * Create and cache vignette gradient
   */
  private createVignetteGradient(
    phase: string,
    intensity: number
  ): CanvasGradient {
    const key = this.getGradientCacheKey("vignette", phase, intensity);
    let gradient = this.getCachedGradient(key);

    if (!gradient) {
      gradient = this.ctx!.createRadialGradient(
        this.centerX,
        this.centerY,
        0,
        this.centerX,
        this.centerY,
        this.maxRadius
      );

      if (phase === "CLIMAX") {
        // Dramatic tunnel walls during climax - much more subtle
        gradient.addColorStop(0, `rgba(0, 0, 0, 0)`);
        gradient.addColorStop(
          0.3,
          `rgba(0, 0, 0, ${0.1 * intensity * this.opacityMultiplier})`
        );
        gradient.addColorStop(
          0.6,
          `rgba(0, 0, 20, ${0.2 * intensity * this.opacityMultiplier})`
        );
        gradient.addColorStop(
          0.8,
          `rgba(0, 0, 0, ${0.3 * intensity * this.opacityMultiplier})`
        );
        gradient.addColorStop(
          1,
          `rgba(0, 0, 0, ${0.4 * intensity * this.opacityMultiplier})`
        );
      } else {
        gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
        gradient.addColorStop(
          0.4,
          `rgba(0, 0, 0, ${0.05 * intensity * this.opacityMultiplier})`
        );
        gradient.addColorStop(
          0.7,
          `rgba(0, 0, 0, ${0.1 * intensity * this.opacityMultiplier})`
        );
        gradient.addColorStop(
          0.9,
          `rgba(0, 0, 0, ${0.15 * intensity * this.opacityMultiplier})`
        );
        gradient.addColorStop(
          1,
          `rgba(0, 0, 0, ${0.2 * intensity * this.opacityMultiplier})`
        );
      }

      this.cacheGradient(key, gradient);
    }

    return gradient;
  }

  /**
   * Create and cache distortion ring gradient
   */
  private createDistortionRingGradient(
    ringIndex: number,
    ringCount: number,
    intensity: number
  ): CanvasGradient {
    const key = this.getGradientCacheKey("distortion", "ring", intensity, {
      ringIndex,
      ringCount,
    });
    let gradient = this.getCachedGradient(key);

    if (!gradient) {
      const radius = (this.maxRadius / ringCount) * ringIndex;
      gradient = this.ctx!.createRadialGradient(
        this.centerX,
        this.centerY,
        radius * 0.7,
        this.centerX,
        this.centerY,
        radius
      );
      gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
      gradient.addColorStop(
        1,
        `rgba(100, 150, 255, ${
          0.1 * intensity * this.opacityMultiplier * (1 - ringIndex / ringCount)
        })`
      );

      this.cacheGradient(key, gradient);
    }

    return gradient;
  }

  /**
   * Create and cache center vortex gradient
   */
  private createVortexGradient(intensity: number): CanvasGradient {
    const key = this.getGradientCacheKey("vortex", "center", intensity);
    let gradient = this.getCachedGradient(key);

    if (!gradient) {
      gradient = this.ctx!.createRadialGradient(
        this.centerX,
        this.centerY,
        0,
        this.centerX,
        this.centerY,
        50 * intensity
      );
      gradient.addColorStop(
        0,
        `rgba(0, 0, 0, ${intensity * this.opacityMultiplier})`
      );
      gradient.addColorStop(
        0.5,
        `rgba(20, 50, 100, ${intensity * 0.5 * this.opacityMultiplier})`
      );
      gradient.addColorStop(1, "rgba(50, 100, 200, 0)");

      this.cacheGradient(key, gradient);
    }

    return gradient;
  }

  /**
   * Create and cache center glow gradient
   */
  private createCenterGlowGradient(
    phase: string,
    intensity: number
  ): CanvasGradient {
    const key = this.getGradientCacheKey("glow", phase, intensity);
    let gradient = this.getCachedGradient(key);

    if (!gradient) {
      const glowIntensity = phase === "CLIMAX" ? 0.8 : 0.3;
      gradient = this.ctx!.createRadialGradient(
        this.centerX,
        this.centerY,
        0,
        this.centerX,
        this.centerY,
        150
      );
      gradient.addColorStop(
        0,
        `rgba(200, 220, 255, ${
          glowIntensity * intensity * this.opacityMultiplier
        })`
      );
      gradient.addColorStop(
        0.5,
        `rgba(150, 200, 255, ${
          glowIntensity * 0.5 * intensity * this.opacityMultiplier
        })`
      );
      gradient.addColorStop(1, "rgba(100, 150, 255, 0)");

      this.cacheGradient(key, gradient);
    }

    return gradient;
  }

  /**
   * Gradient cache management
   */
  private getGradientCacheKey(
    type: string,
    phase: string,
    intensity: number,
    additionalParams: Record<string, unknown> = {}
  ): string {
    // Create a cache key based on parameters that affect gradient appearance
    const intensityQuantized = Math.floor(intensity * 20) / 20; // Quantize to reduce cache size
    const params = Object.entries(additionalParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(",");

    return `${type}_${phase}_${intensityQuantized}_${this.canvas!.width}x${
      this.canvas!.height
    }_${params}`;
  }

  private getCachedGradient(key: string): CanvasGradient | null {
    const gradient = this.gradientCache.get(key);
    if (gradient) {
      this.cacheHits++;
      return gradient;
    }
    this.cacheMisses++;
    return null;
  }

  private cacheGradient(key: string, gradient: CanvasGradient): void {
    // Implement LRU cache eviction
    if (this.gradientCache.size >= this.maxCacheSize) {
      const firstKey = this.gradientCache.keys().next().value;
      if (firstKey !== undefined) {
        this.gradientCache.delete(firstKey);
      }
    }
    this.gradientCache.set(key, gradient);
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
    cacheSize: number;
    cacheHits: number;
    cacheMisses: number;
    hitRate: string;
    maxCacheSize: number;
    trailPool: Record<string, unknown>;
    activeTrails: number;
    trigCache: {
      sinCacheSize: number;
      cosCacheSize: number;
    };
    adaptiveFrameRate: {
      enabled: boolean;
      currentThreshold: string;
      avgFrameTime: string;
      performanceHistorySize: number;
    };
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

    const totalRequests = this.cacheHits + this.cacheMisses;
    const hitRate =
      totalRequests > 0
        ? ((this.cacheHits / totalRequests) * 100).toFixed(1)
        : "0";

    const trailStats = this.trailPool.getStats();

    return {
      cacheHitRate,
      averageFrameTime: avgFrameTime,
      currentThreshold: this._renderThreshold,
      trailCount: this.trails.length,
      cacheSize: this.gradientCache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate: `${hitRate}%`,
      maxCacheSize: this.maxCacheSize,
      trailPool: trailStats as unknown as Record<string, unknown>,
      activeTrails: this.trails.length,
      trigCache: {
        sinCacheSize: this._sinCache.size,
        cosCacheSize: this._cosCache.size,
      },
      adaptiveFrameRate: {
        enabled: this._adaptiveFrameRate,
        currentThreshold: this._renderThreshold.toFixed(1),
        avgFrameTime: avgFrameTime.toFixed(2),
        performanceHistorySize: this._performanceHistory.length,
      },
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
    this._needsFullClear = true;
    this.clearCache();
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
    this.clearTrigCaches();

    // Remove event listeners
    window.removeEventListener("resize", () => this.resizeCanvas());

    this.canvas = null;
    this.ctx = null;

    console.debug("WarpOverlay: Disposed");
  }

  /**
   * Get trail pool statistics
   */
  public getTrailPoolStats(): TrailPoolStats {
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
