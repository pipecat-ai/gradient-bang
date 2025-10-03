/**
 * Trail object pool for efficient memory management
 * Pre-allocates trail objects to avoid runtime allocation
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Trail object for particle effects */
export interface Trail {
  baseAngle: number;
  angle: number;
  radius: number;
  speed: number;
  length: number;
  maxLength: number;
  opacity: number;
  thickness: number;
  delay: number;
  rotationSpeed: number;
  distance: number;
  layer: number;
}

/** Trail pool statistics */
export interface TrailPoolStats {
  poolSize: number;
  activeSize: number;
  totalSize: number;
  utilizationRate: number;
}

/** Trail pool configuration */
export interface TrailPoolConfig {
  initialSize?: number;
  expansionSize?: number;
  maxSize?: number;
  autoExpand?: boolean;
}

// ============================================================================
// TRAIL POOL CLASS
// ============================================================================

/**
 * TrailPool Class
 * Manages a pool of trail objects for efficient memory usage in particle systems
 */
export class TrailPool {
  private pool: Trail[];
  private active: Trail[];
  private config: Required<TrailPoolConfig>;

  constructor(config: TrailPoolConfig = {}) {
    this.config = {
      initialSize: config.initialSize ?? 400,
      expansionSize: config.expansionSize ?? 50,
      maxSize: config.maxSize ?? 2000,
      autoExpand: config.autoExpand ?? true,
    };

    this.pool = [];
    this.active = [];

    this.expand(this.config.initialSize);
  }

  /**
   * Expands the pool by creating new trail objects
   */
  public expand(count: number): void {
    const currentTotal = this.getTotalSize();
    const actualCount = Math.min(count, this.config.maxSize - currentTotal);

    if (actualCount <= 0) {
      console.warn("TrailPool: Cannot expand - maximum size reached");
      return;
    }

    for (let i = 0; i < actualCount; i++) {
      this.pool.push(this.createTrail());
    }

    console.debug(
      `TrailPool: Expanded by ${actualCount} trails (total: ${this.getTotalSize()})`
    );
  }

  /**
   * Creates a new trail object with default values
   */
  private createTrail(): Trail {
    return {
      baseAngle: 0,
      angle: 0,
      radius: 0,
      speed: 0,
      length: 0,
      maxLength: 0,
      opacity: 0,
      thickness: 0,
      delay: 0,
      rotationSpeed: 0,
      distance: 0,
      layer: 0,
    };
  }

  /**
   * Gets a trail object from the pool
   */
  public get(): Trail | null {
    // Auto-expand if enabled and pool is empty
    if (this.pool.length === 0) {
      if (this.config.autoExpand) {
        this.expand(this.config.expansionSize);
      } else {
        console.warn(
          "TrailPool: No available trails and auto-expand is disabled"
        );
        return null;
      }
    }

    // If still no trails available after expansion attempt
    if (this.pool.length === 0) {
      return null;
    }

    const trail = this.pool.pop()!;
    this.active.push(trail);

    // Reset trail properties to defaults
    this.resetTrailProperties(trail);

    return trail;
  }

  /**
   * Returns a trail object to the pool
   */
  public reset(trail: Trail): boolean {
    const index = this.active.indexOf(trail);
    if (index === -1) {
      console.warn("TrailPool: Attempted to reset trail not in active list");
      return false;
    }

    this.active.splice(index, 1);
    this.pool.push(trail);

    // Reset properties for reuse
    this.resetTrailProperties(trail);

    return true;
  }

  /**
   * Returns all active trails to the pool
   */
  public resetAll(): void {
    // Reset properties for all active trails
    for (const trail of this.active) {
      this.resetTrailProperties(trail);
    }

    // Move all active trails back to pool
    this.pool.push(...this.active);
    this.active.length = 0;

    console.debug(
      `TrailPool: Reset all trails (pool size: ${this.pool.length})`
    );
  }

  /**
   * Resets trail properties to default values
   */
  private resetTrailProperties(trail: Trail): void {
    trail.baseAngle = 0;
    trail.angle = 0;
    trail.radius = 0;
    trail.speed = 0;
    trail.length = 0;
    trail.maxLength = 0;
    trail.opacity = 0;
    trail.thickness = 0;
    trail.delay = 0;
    trail.rotationSpeed = 0;
    trail.distance = 0;
    trail.layer = 0;
  }

  /**
   * Gets pool statistics
   */
  public getStats(): TrailPoolStats {
    const poolSize = this.pool.length;
    const activeSize = this.active.length;
    const totalSize = poolSize + activeSize;
    const utilizationRate = totalSize > 0 ? activeSize / totalSize : 0;

    return {
      poolSize,
      activeSize,
      totalSize,
      utilizationRate,
    };
  }

  /**
   * Gets the total number of trail objects (active + pooled)
   */
  public getTotalSize(): number {
    return this.pool.length + this.active.length;
  }

  /**
   * Gets the number of available trails in the pool
   */
  public getAvailableCount(): number {
    return this.pool.length;
  }

  /**
   * Gets the number of active trails
   */
  public getActiveCount(): number {
    return this.active.length;
  }

  /**
   * Checks if the pool is empty
   */
  public isEmpty(): boolean {
    return this.pool.length === 0;
  }

  /**
   * Checks if the pool is at maximum capacity
   */
  public isAtMaxCapacity(): boolean {
    return this.getTotalSize() >= this.config.maxSize;
  }

  /**
   * Gets the utilization rate (active / total)
   */
  public getUtilizationRate(): number {
    const total = this.getTotalSize();
    return total > 0 ? this.active.length / total : 0;
  }

  /**
   * Shrinks the pool by removing unused trail objects
   */
  public shrink(targetSize?: number): number {
    const currentPoolSize = this.pool.length;
    const target = targetSize ?? this.config.initialSize;

    if (currentPoolSize <= target) {
      return 0; // Already at or below target size
    }

    const removeCount = currentPoolSize - target;
    this.pool.splice(target);

    console.debug(
      `TrailPool: Shrunk by ${removeCount} trails (pool size: ${this.pool.length})`
    );
    return removeCount;
  }

  /**
   * Updates pool configuration
   */
  public updateConfig(newConfig: Partial<TrailPoolConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Adjust pool size if maxSize changed
    if (
      newConfig.maxSize !== undefined &&
      this.getTotalSize() > newConfig.maxSize
    ) {
      const excess = this.getTotalSize() - newConfig.maxSize;
      this.shrink(Math.max(0, this.pool.length - excess));
    }
  }

  /**
   * Gets current pool configuration
   */
  public getConfig(): TrailPoolConfig {
    return { ...this.config };
  }

  /**
   * Disposes of the pool and clears all references
   */
  public dispose(): void {
    this.pool.length = 0;
    this.active.length = 0;
    console.debug("TrailPool: Disposed");
  }

  /**
   * Creates a snapshot of all active trails
   */
  public getActiveTrails(): readonly Trail[] {
    return [...this.active];
  }

  /**
   * Validates pool integrity (for debugging)
   */
  public validateIntegrity(): boolean {
    const hasOverlap = this.active.some((trail) => this.pool.includes(trail));

    if (hasOverlap) {
      console.error(
        "TrailPool: Integrity violation - trail exists in both active and pool arrays"
      );
      return false;
    }

    return true;
  }
}
