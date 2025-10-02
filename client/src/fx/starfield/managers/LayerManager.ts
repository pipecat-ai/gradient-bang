/**
 * Layer Manager
 * Manages the dimming of different layers when a game object is selected
 */

import type { GalaxyStarfield } from "../Starfield";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Dimming configuration */
export interface DimConfig {
  dimIntensity: number;
  dimDuration: number;
}

/** Dimming animation state */
export interface DimAnimation {
  isAnimating: boolean;
  startTime: number;
  startIntensity: number;
  targetIntensity: number;
  duration: number;
}

// ============================================================================
// LAYER MANAGER CLASS
// ============================================================================

/**
 * LayerManager Class
 * Manages layer dimming effects for visual focus
 */
export class LayerManager {
  private starfield: GalaxyStarfield;
  private isDimmed: boolean;
  private dimConfig: DimConfig;
  private dimAnimation: DimAnimation;

  constructor(starfield: GalaxyStarfield) {
    this.starfield = starfield;

    // Track if layers are currently dimmed
    this.isDimmed = false;

    // Dimming configuration
    this.dimConfig = {
      dimIntensity: starfield.config.layerDimOpacity || 0.3,
      dimDuration: starfield.config.layerDimDuration || 1.5,
    };

    // Animation state
    this.dimAnimation = {
      isAnimating: false,
      startTime: 0,
      startIntensity: 1,
      targetIntensity: 1,
      duration: 0,
    };
  }

  /**
   * Initialize layer tracking from the starfield
   */
  public initializeLayers(): void {
    // No initialization needed - materials are checked dynamically
  }

  /**
   * Start a dimming animation
   */
  public startDimAnimation(fromIntensity: number, toIntensity: number): void {
    this.dimAnimation.isAnimating = true;
    this.dimAnimation.startTime = this.starfield.clock.getElapsedTime();
    this.dimAnimation.startIntensity = fromIntensity;
    this.dimAnimation.targetIntensity = toIntensity;
    this.dimAnimation.duration = this.dimConfig.dimDuration;

    // Set the dimming state based on target intensity
    this.isDimmed = toIntensity < 1.0;
  }

  /**
   * Update dimming animation (called each frame)
   */
  public updateDimAnimation(currentTime: number): void {
    if (!this.dimAnimation.isAnimating) return;

    const elapsed = currentTime - this.dimAnimation.startTime;
    const progress = Math.min(elapsed / this.dimAnimation.duration, 1.0);

    // Check if animation is complete
    if (progress >= 1.0) {
      this.dimAnimation.isAnimating = false;
    }
  }

  /**
   * Easing function for smooth transitions
   */
  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Start dimming animation using config values
   */
  public startDimming(): void {
    this.startDimAnimation(1.0, this.dimConfig.dimIntensity);
  }

  /**
   * Start restoration animation using config values
   */
  public startRestoration(): void {
    this.startDimAnimation(this.dimConfig.dimIntensity, 1.0);
  }

  /**
   * Get current dimming state
   */
  public isLayersDimmed(): boolean {
    return this.isDimmed;
  }

  /**
   * Get current dimming factors for all layers
   */
  public getDimmingFactors(): { [materialId: string]: number } {
    // Calculate current intensity based on animation state
    let currentIntensity = 1.0;

    if (this.dimAnimation.isAnimating) {
      const currentTime = this.starfield.clock.getElapsedTime();
      const elapsed = currentTime - this.dimAnimation.startTime;
      const progress = Math.min(elapsed / this.dimAnimation.duration, 1.0);

      // Apply easing
      const easedProgress = this.easeOutCubic(progress);

      // Calculate current intensity
      currentIntensity =
        this.dimAnimation.startIntensity +
        (this.dimAnimation.targetIntensity - this.dimAnimation.startIntensity) *
          easedProgress;
    } else if (this.isDimmed) {
      currentIntensity = this.dimConfig.dimIntensity;
    }

    // Return dimming factors for all layers - ConfigUniformMapper will handle material availability
    return {
      clouds: currentIntensity,
      nebula: currentIntensity,
      background: currentIntensity,
    };
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    this.isDimmed = false;
    this.dimAnimation.isAnimating = false;
  }
}
