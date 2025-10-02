/**
 * Performance monitoring system
 * Integrates Stats.js with custom Three.js metrics
 */

import Stats from "stats.js";
import * as THREE from "three";

import { formatNumber } from "./utils/formatting";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Performance threshold configuration */
export interface PerformanceThreshold {
  warning: number;
  critical: number;
}

/** Complete performance thresholds configuration */
export interface PerformanceThresholds {
  frameTime: PerformanceThreshold;
  drawCalls: PerformanceThreshold;
  triangles: PerformanceThreshold;
  starCount: PerformanceThreshold;
  geometries: PerformanceThreshold;
  textures: PerformanceThreshold;
  programs: PerformanceThreshold;
}

/** Performance statistics for a frame */
export interface FrameStats {
  frameTime: number;
  drawCalls: number;
  triangles: number;
  starCount: number;
  geometries: number;
  textures: number;
  programs: number;
  status: string;
}

/** DOM elements for performance UI */
export interface PerformanceElements {
  panel?: HTMLElement;
  toggle?: HTMLElement;
  content?: HTMLElement;
  frameTime?: HTMLElement;
  drawCalls?: HTMLElement;
  triangles?: HTMLElement;
  starCount?: HTMLElement;
  geometries?: HTMLElement;
  textures?: HTMLElement;
  programs?: HTMLElement;
  status?: HTMLElement;
}

/** Performance monitoring status */
export type PerformanceStatus =
  | "Running"
  | "Paused"
  | "Warning"
  | "Critical"
  | "Error";

/** Performance level for styling */
export type PerformanceLevel = "normal" | "warning" | "critical";

// ============================================================================
// PERFORMANCE MONITOR CLASS
// ============================================================================

/**
 * PerformanceMonitor Class
 * Integrates Stats.js with custom Three.js performance metrics and provides visual feedback
 */
export class PerformanceMonitor {
  private scene: THREE.Scene;
  private stats: Stats | null;
  private thresholds: PerformanceThresholds;
  private elements: PerformanceElements;
  private lastFrameStats: FrameStats;

  constructor(_renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.scene = scene;
    this.stats = null;

    // Performance thresholds
    this.thresholds = {
      frameTime: { warning: 20, critical: 30 }, // ms
      drawCalls: { warning: 50, critical: 100 },
      triangles: { warning: 100000, critical: 500000 },
      starCount: { warning: 10000, critical: 50000 },
      geometries: { warning: 100, critical: 200 },
      textures: { warning: 50, critical: 100 },
      programs: { warning: 20, critical: 40 },
    };

    // DOM elements
    this.elements = {};

    // Store last frame stats for when panel becomes visible
    this.lastFrameStats = {
      frameTime: 0,
      drawCalls: 0,
      triangles: 0,
      starCount: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
      status: "Running",
    };

    this.initDOMElements();
  }

  /**
   * Destroy performance monitor - removes all DOM elements and cleans up
   */
  public destroy(): void {
    // Remove Stats.js from DOM
    if (this.stats?.dom && this.stats.dom.parentNode) {
      this.stats.dom.parentNode.removeChild(this.stats.dom);
    }

    // Remove performance container
    const container = document.getElementById("performance-container");
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }

    // Clear references
    this.stats = null;
    this.elements = {};
  }

  /**
   * Initialize DOM elements for performance display
   */
  private initDOMElements(): void {
    if (typeof Stats !== "undefined") {
      this.stats = new Stats();
      this.stats.dom.style.position = "relative";
      this.stats.dom.style.background = "transparent";
      this.stats.dom.style.border = "1px solid #00ff41";
      this.stats.dom.style.borderRadius = "3px";

      let container = document.getElementById("performance-container");
      if (!container) {
        // Create the container if it doesn't exist
        container = document.createElement("div");
        container.id = "performance-container";
        container.className = "performance-container";
        document.body.appendChild(container);
      }

      // Create performance panel HTML
      container.innerHTML = `
        <div id="performance-panel" class="performance-panel">
          <div id="performance-content" class="perf-content">
            <div id="statsContainer"></div>
            <div class="perf-metrics">
              <div class="perf-metric">
                <span class="perf-label">Frame:</span>
                <span id="perf-frame-time" class="perf-value">0</span>
              </div>
              <div class="perf-metric">
                <span class="perf-label">Draws:</span>
                <span id="perf-draw-calls" class="perf-value">0</span>
              </div>
              <div class="perf-metric">
                <span class="perf-label">Tris:</span>
                <span id="perf-triangles" class="perf-value">0</span>
              </div>
              <div class="perf-metric">
                <span class="perf-label">Stars:</span>
                <span id="perf-star-count" class="perf-value">0</span>
              </div>
              <div class="perf-metric">
                <span class="perf-label">Geoms:</span>
                <span id="perf-geometries" class="perf-value">0</span>
              </div>
              <div class="perf-metric">
                <span class="perf-label">Texs:</span>
                <span id="perf-textures" class="perf-value">0</span>
              </div>
              <div class="perf-metric">
                <span class="perf-label">Progs:</span>
                <span id="perf-programs" class="perf-value">0</span>
              </div>
              <div class="perf-metric">
                <span class="perf-label">Status:</span>
                <span id="perf-status" class="perf-value">Running</span>
              </div>
            </div>
          </div>
        </div>
      `;

      // Move Stats.js into the performance panel
      const statsContainer = document.getElementById("statsContainer");
      if (statsContainer) {
        statsContainer.appendChild(this.stats.dom);
      }
    }

    // Cache DOM element references
    if (!this.elements) {
      this.elements = {};
    }

    const elementIds = [
      "performance-panel",
      "performance-content",
      "perf-frame-time",
      "perf-draw-calls",
      "perf-triangles",
      "perf-star-count",
      "perf-geometries",
      "perf-textures",
      "perf-programs",
      "perf-status",
    ];

    for (const id of elementIds) {
      const element = document.getElementById(id);
      if (element) {
        let key: keyof PerformanceElements;

        // Map specific IDs to element keys
        switch (id) {
          case "perf-frame-time":
            key = "frameTime";
            break;
          case "perf-draw-calls":
            key = "drawCalls";
            break;
          case "perf-triangles":
            key = "triangles";
            break;
          case "perf-star-count":
            key = "starCount";
            break;
          case "perf-geometries":
            key = "geometries";
            break;
          case "perf-textures":
            key = "textures";
            break;
          case "perf-programs":
            key = "programs";
            break;
          case "perf-status":
            key = "status";
            break;
          case "performance-panel":
            key = "panel";
            break;
          case "performance-content":
            key = "content";
            break;
          default:
            continue;
        }

        this.elements[key] = element;
      }
    }

    // Show panel and update UI
    this.updateUIElements();
  }

  /**
   * Begin frame measurement
   */
  public begin(): void {
    if (!this.stats) return;
    this.stats.begin();
  }

  /**
   * End frame measurement
   */
  public end(): void {
    if (!this.stats) return;
    this.stats.end();
  }

  /**
   * Update performance metrics
   */
  public update(
    frameTime: number,
    drawCalls: number,
    triangles: number,
    programs: number,
    geometries: number,
    textures: number
  ): void {
    this.lastFrameStats = {
      frameTime,
      drawCalls,
      triangles,
      starCount: 0,
      geometries,
      textures,
      programs,
      status: "Running",
    };

    // Count scene objects for additional metrics
    let starCount = 0;
    if (this.scene && this.scene.children) {
      for (const child of this.scene.children) {
        if (child instanceof THREE.Points) {
          const geometry = child.geometry as THREE.BufferGeometry;
          if (geometry.attributes.position) {
            starCount += geometry.attributes.position.count;
          }
        }
      }
    }

    // Store the calculated star count
    this.lastFrameStats.starCount = starCount;

    this.updateUIElements();
  }

  /**
   * Update performance display elements
   */
  private updateUIElements(): void {
    if (!this.elements || !this.elements.frameTime) {
      console.warn("Missing elements or frameTime element");
      return;
    }

    const stats = this.lastFrameStats;

    // Update each metric with threshold checking
    this.updateElement(
      "frameTime",
      `${stats.frameTime.toFixed(1)}`,
      stats.frameTime,
      "frameTime"
    );

    this.updateElement(
      "drawCalls",
      formatNumber(stats.drawCalls),
      stats.drawCalls,
      "drawCalls"
    );

    this.updateElement(
      "triangles",
      formatNumber(stats.triangles),
      stats.triangles,
      "triangles"
    );

    this.updateElement(
      "starCount",
      formatNumber(stats.starCount),
      stats.starCount,
      "starCount"
    );

    this.updateElement(
      "geometries",
      formatNumber(stats.geometries),
      stats.geometries,
      "geometries"
    );

    this.updateElement(
      "textures",
      formatNumber(stats.textures),
      stats.textures,
      "textures"
    );

    this.updateElement(
      "programs",
      formatNumber(stats.programs),
      stats.programs,
      "programs"
    );

    // Update status
    this.updateStatus(stats.status as PerformanceStatus);
  }

  /**
   * Update individual performance element with threshold styling
   */
  private updateElement(
    key: keyof PerformanceElements,
    displayValue: string,
    numericValue: number,
    thresholdKey: keyof PerformanceThresholds
  ): void {
    const element = this.elements[key];
    if (!element) {
      return;
    }

    element.textContent = displayValue;

    // Apply threshold-based styling using CSS classes
    const threshold = this.thresholds[thresholdKey];
    if (threshold) {
      // Remove existing classes
      element.classList.remove("warning", "critical");

      if (numericValue >= threshold.critical) {
        element.classList.add("critical");
      } else if (numericValue >= threshold.warning) {
        element.classList.add("warning");
      }
    }
  }

  /**
   * Update performance status
   */
  public updateStatus(status: PerformanceStatus): void {
    const element = this.elements.status;
    if (element) {
      element.textContent = status;
    }
  }

  /**
   * Get current performance statistics
   */
  public getStats(): FrameStats {
    return { ...this.lastFrameStats };
  }

  /**
   * Get performance thresholds
   */
  public getThresholds(): PerformanceThresholds {
    return { ...this.thresholds };
  }

  /**
   * Update performance thresholds
   */
  public setThresholds(thresholds: Partial<PerformanceThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  /**
   * Get Stats.js instance
   */
  public getStatsInstance(): Stats | null {
    return this.stats;
  }
}
