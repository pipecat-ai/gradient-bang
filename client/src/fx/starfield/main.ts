import * as THREE from "three";

import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

import {
  colorAdjustFragmentShader,
  colorAdjustVertexShader,
} from "./shaders/colorAdjust";
import { sharpenFragmentShader, sharpenVertexShader } from "./shaders/sharpen";
import {
  terminalFragmentShader,
  terminalVertexShader,
} from "./shaders/terminal";

import { ConfigUniformMapper } from "./ConfigUniformMapper";
import { CameraLookAtAnimator } from "./animations/CameraLookAt";
import { WarpOverlay } from "./animations/WarpOverlay";
import { GameObjectManager } from "./managers/GameObjectManager";
import { LayerManager } from "./managers/LayerManager";
import { SceneManager } from "./managers/SceneManager";
import { ShadowManager } from "./managers/ShadowManager";
import { StarLayerManager } from "./managers/StarLayerManager";
import { UniformManager } from "./managers/UniformManager";

import {
  DEFAULT_GALAXY_CONFIG,
  type GalaxyStarfieldConfig,
  type StarfieldSceneConfig,
  type WarpPhase,
} from "./constants";

import {
  type GameObjectBaseConfig,
  type GameObjectInstance,
  type GameObjectTypes,
} from "./types/GameObject";

import customDeepmerge from "./utils/merge";

import { Background, Clouds, Nebula } from "./fx";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Animation states for the starfield */
export type StarfieldState = "idle" | "shake" | "warping";

/** Callback function signatures */
export interface StarfieldCallbacks {
  onGameObjectInView?: ((gameObject: GameObjectInstance) => void) | null;
  onGameObjectSelected?: ((gameObject: GameObjectInstance) => void) | null;
  onGameObjectCleared?: (() => void) | null;
  onWarpStart?: (() => void) | null;
  onWarpComplete?: (() => void) | null;
  onWarpCancel?: (() => void) | null;
  onSceneIsLoading?: (() => void) | null;
  onSceneReady?:
    | ((isInitialRender: boolean, sceneId: string | null) => void)
    | null;
}

/** Frame state for animation loop */
export interface FrameState {
  currentState: StarfieldState;
  currentShakeIntensity: number;
  shakePhase: number;
  cloudsShakeProgress: number;
  warpProgress: number;
  tunnelEffectValue: number;
  warpPhase: WarpPhase;
  cameraRotation: {
    x: number;
    y: number;
    z: number;
  };
}

/** Cached uniform values for performance optimization */
export interface CachedUniforms {
  shakeIntensity: number;
  warpProgress: number;
  tunnelEffect: number;
  forwardOffset: number;
}

/** Cached configuration values for performance */
export interface CachedConfig {
  shakeIntensity: number;
  shakeSpeed: number;
  forwardDriftIdle: number;
  forwardDriftShake: number;
  idleSwayRandomSpeed: number;
  idleSwayRandomIntensity: number;
  warpFOVMax: number;
}

/** Performance statistics */
export interface PerformanceStats {
  drawCalls: number;
  triangles: number;
  programs: number;
  frameTime: number;
  lastFrameStart: number;
  geometries: number;
  textures: number;
}

/** Game object selection options */
export interface SelectionOptions {
  animate?: boolean;
  duration?: number;
  zoom?: boolean;
  focus?: boolean;
  zoomFactor?: number;
  [key: string]: unknown;
}

/** Look at animation options */
export interface LookAtOptions {
  duration?: number;
  zoom?: boolean;
  easing?: string;
  zoomFactor?: number;
  onComplete?: () => void;
  [key: string]: unknown;
}

/** Warp destination options */
export interface WarpOptions {
  id?: string;
  name?: string;
  sceneConfig?: Partial<StarfieldSceneConfig>; // Scene variant config (partial or full)
  gameObjects?: GameObjectBaseConfig[];
  bypassAnimation?: boolean; // Skip warp animation and load scene directly
  bypassFlash?: boolean; // Skip flash transition effect (default: true)
  bypassCooldown?: boolean; // Skip warp cooldown timer (default: false)
}

// ============================================================================
// MAIN STARFIELD CLASS
// ============================================================================

export class GalaxyStarfield {
  // Configuration and callbacks
  public config: GalaxyStarfieldConfig;
  public debugMode: boolean;
  public callbacks: StarfieldCallbacks;

  // Core state
  public state: StarfieldState;

  // Three.js core objects
  public scene!: THREE.Scene;
  public camera!: THREE.PerspectiveCamera;
  public renderer!: THREE.WebGLRenderer;
  public composer!: EffectComposer;

  // Timing
  public clock: THREE.Clock;
  public frameCount: number;

  // Warp animation state
  public warpTime: number;
  public warpElapsedSec: number;
  public warpPhase: WarpPhase;
  public warpProgress: number;
  public shakeIntensityMultiplier: number;
  public currentShakeIntensity: number;
  public currentForwardOffset: number;
  public tunnelEffectValue: number;
  public lastWidth: number;
  public lastHeight: number;

  // Visibility and pause state management
  public isPaused: boolean;
  public isManuallyPaused: boolean;
  public animationId: number | null;

  // Pending sector config for warping (now using lightweight scene variants)
  private _pendingSectorConfig: StarfieldSceneConfig | null;

  // Current active scene ID
  private _currentSceneId: string | null;

  // Promise resolver for warp completion
  private _warpPromiseResolver: ((success: boolean) => void) | null;

  // Reusable objects to prevent garbage collection
  private _frameState: FrameState;

  // Cached uniform values for batching optimization
  private _cachedUniforms: CachedUniforms;

  // Cached frequently accessed config values for performance
  private _cachedConfig: CachedConfig;

  // Performance monitoring
  public perfStats: PerformanceStats;

  // Manager instances
  public controlsManager?: {
    destroy: () => void;
    refresh: () => void;
  } | null;
  public uniformManager: UniformManager;
  public configMapper: ConfigUniformMapper;
  public warpOverlay: WarpOverlay;
  public performanceMonitor?: {
    begin: () => void;
    end: () => void;
    update: (
      frameTime: number,
      drawCalls: number,
      triangles: number,
      programs: number,
      geometries: number,
      textures: number
    ) => void;
    updateStatus: (status: "Running" | "Paused" | "Warning") => void;
    destroy: () => void;
  } | null;
  public starLayerManager?: StarLayerManager;
  public layerManager?: LayerManager;
  public gameObjectManager?: GameObjectManager;
  public sceneManager?: SceneManager;
  public cameraLookAtAnimator?: CameraLookAtAnimator;
  public shadowManager?: ShadowManager;

  // Scene elements
  private _nebula?: Nebula;
  private _clouds?: Clouds;
  private _background?: Background;

  // Post-processing passes
  public terminalPass?: ShaderPass;
  public sharpenPass?: ShaderPass;
  public colorAdjustPass?: ShaderPass;
  public renderPass?: RenderPass;
  public terminalShader?: {
    uniforms: Record<string, unknown>;
    vertexShader: string;
    fragmentShader: string;
  };
  public sharpenShader?: {
    uniforms: Record<string, unknown>;
    vertexShader: string;
    fragmentShader: string;
  };
  public colorAdjustShader?: {
    uniforms: Record<string, unknown>;
    vertexShader: string;
    fragmentShader: string;
  };
  public outputPass?: OutputPass;

  public starsGeometry?: THREE.BufferGeometry;
  public starsMaterial?: THREE.ShaderMaterial;
  public stars?: THREE.Points;
  public originalPositions?: Float32Array;
  public originTarget?: THREE.Vector3;
  public cameraLookAtLock?: { mesh: THREE.Mesh } | null;

  // DOM elements
  public whiteFlash?: HTMLElement | null;
  private _targetElement?: HTMLElement | null;

  // Private animation state
  private _warpStartTime?: number;
  private _pauseStartTime?: number;
  private _totalPausedTime: number = 0;
  private _shakeTransitionTo?: number;
  private _initialLoadComplete: boolean;
  private _updatePhaseText?: (phase: string) => void;
  private _shakeTransitionStartMs?: number;
  private _shakeTransitionFrom?: number;
  private _currentShakeBlend?: number;
  private _warpCompleted: boolean;
  private _preShakeRotation?: { x: number; y: number; z: number };
  private _phasePrefix: string;
  private _cloudsShakeStartTime?: number;
  private _isRendering: boolean = false;

  // Scene loading state management
  private _sceneLoadPromise: Promise<void> | null = null;
  private _sceneReady: boolean = false;
  private _sceneSettleStartTime: number | undefined;
  private _flashHoldStartTime: number | undefined;
  private _isFirstRender: boolean = true;
  private readonly SCENE_SETTLE_DURATION = 150;
  private readonly MIN_FLASH_HOLD_TIME = 300;
  private readonly MAX_FLASH_HOLD_TIME = 5000;

  // Warp cooldown management
  private _warpCooldownTimer: number | null = null;

  constructor(
    config: Partial<GalaxyStarfieldConfig> = {},
    callbacks: StarfieldCallbacks = {},
    targetElement?: HTMLElement
  ) {
    this._targetElement = targetElement || document.body;

    this.config = { ...DEFAULT_GALAXY_CONFIG, ...config };

    this.debugMode = config.debugMode !== undefined ? config.debugMode : false;
    this.callbacks = {
      onGameObjectInView: null,
      onGameObjectSelected: null,
      onGameObjectCleared: null,
      onWarpStart: null,
      onWarpComplete: null,
      onWarpCancel: null,
      onSceneIsLoading: null,
      onSceneReady: null,
      ...callbacks,
    };

    this.state = "idle";

    this.clock = new THREE.Clock();
    this.clock.start();
    this.frameCount = 0;

    this.warpTime = 0;
    this.warpElapsedSec = 0;
    this.warpPhase = "IDLE";
    this.warpProgress = 0;
    this.shakeIntensityMultiplier = 0;
    this.currentShakeIntensity = 0;
    this.currentForwardOffset = 0;
    this.tunnelEffectValue = 0;
    const containerRect = this._targetElement?.getBoundingClientRect();
    this.lastWidth = containerRect?.width || window.innerWidth;
    this.lastHeight = containerRect?.height || window.innerHeight;

    this.isPaused = false;
    this.isManuallyPaused = false;
    this.animationId = null;

    this._pendingSectorConfig = null;
    this._currentSceneId = null;
    this._warpPromiseResolver = null;

    this._frameState = {
      currentState: "idle",
      currentShakeIntensity: 0,
      shakePhase: 0,
      cloudsShakeProgress: 0,
      warpProgress: 0,
      tunnelEffectValue: 0,
      warpPhase: "IDLE",
      cameraRotation: { x: 0, y: 0, z: 0 },
    };

    this._cachedUniforms = {
      shakeIntensity: 0,
      warpProgress: 0,
      tunnelEffect: 0,
      forwardOffset: 0,
    };

    this._cachedConfig = {
      shakeIntensity: 0,
      shakeSpeed: 0,
      forwardDriftIdle: 0,
      forwardDriftShake: 0,
      idleSwayRandomSpeed: 0,
      idleSwayRandomIntensity: 0,
      warpFOVMax: 60,
    };

    this.perfStats = {
      drawCalls: 0,
      triangles: 0,
      programs: 0,
      frameTime: 0,
      lastFrameStart: 0,
      geometries: 0,
      textures: 0,
    };

    this.controlsManager = null;

    this.uniformManager = new UniformManager();
    this.configMapper = new ConfigUniformMapper(this.uniformManager);
    this.warpOverlay = new WarpOverlay();
    this.shadowManager = new ShadowManager(this.uniformManager, this.config);

    this.whiteFlash = document.getElementById("whiteFlash");

    this._warpCompleted = false;
    this._phasePrefix = "Warp Phase: ";

    this.init();
    this.updateCachedConfig();

    this.initVisibilityHandling();
    this.initWindowResize();

    if (this.debugMode) {
      this._lazyLoadControlsManager();
      this._lazyLoadPerformanceMonitor();
    }

    this._initialLoadComplete = true;
  }

  /**
   * Lazy load controls manager (async, non-blocking)
   * @private
   */
  private async _lazyLoadControlsManager(): Promise<void> {
    if (this.controlsManager) return;

    try {
      const { ControlsManager } = await import("./managers/ControlsManager");
      this.controlsManager = new ControlsManager(
        this
      ) as unknown as typeof this.controlsManager;
    } catch (err) {
      console.error("[STARFIELD] Failed to load ControlsManager:", err);
    }
  }

  /**
   * Lazy load performance monitor (async, non-blocking)
   * @private
   */
  private async _lazyLoadPerformanceMonitor(): Promise<void> {
    if (this.performanceMonitor) return;

    try {
      const { PerformanceMonitor } = await import("./PerformanceMonitor");
      this.performanceMonitor = new PerformanceMonitor(
        this.renderer,
        this.scene
      ) as unknown as typeof this.performanceMonitor;
    } catch (err) {
      console.error("[STARFIELD] Failed to load PerformanceMonitor:", err);
    }
  }

  // ============================================================================
  // DEBUG MODE CONTROL
  // ============================================================================

  /**
   * Enable debug mode - shows HUD, enables performance monitoring, allows config updates
   */
  public async enableDebugMode(): Promise<void> {
    if (this.debugMode) return;

    this.debugMode = true;

    await this._lazyLoadControlsManager();
    await this._lazyLoadPerformanceMonitor();
  }

  /**
   * Disable debug mode - hides HUD, disables performance monitoring, prevents config updates
   */
  public disableDebugMode(): void {
    if (!this.debugMode) return;

    this.debugMode = false;

    if (this.controlsManager) {
      this.controlsManager.destroy();
      this.controlsManager = null;
    }

    if (this.performanceMonitor) {
      this.performanceMonitor.destroy();
      this.performanceMonitor = null;
    }
  }

  /**
   * Toggle debug mode on/off
   */
  public async toggleDebugMode(): Promise<void> {
    if (this.debugMode) {
      this.disableDebugMode();
    } else {
      await this.enableDebugMode();
    }
  }

  // ============================================================================
  // VISIBILITY & PAUSE MANAGEMENT
  // ============================================================================

  private initVisibilityHandling(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.pauseForVisibility();
        if (this.debugMode && this.performanceMonitor) {
          this.performanceMonitor.updateStatus("Paused");
        }
      } else {
        if (!this.isManuallyPaused) {
          this.forceResume();
        }
      }
    });

    window.addEventListener("blur", () => {
      if (!this.isPaused) {
        this.pauseForVisibility();
        if (this.debugMode && this.performanceMonitor) {
          this.performanceMonitor.updateStatus("Paused");
        }
      }
    });

    window.addEventListener("focus", () => {
      if (!document.hidden && !this.isManuallyPaused) {
        this.forceResume();
      }
    });
  }

  private initWindowResize(): void {
    let resizeTimeout: number;
    const debouncedResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(() => {
        requestAnimationFrame(() => this.onContainerResize());
      }, 100);
    };

    if (window.ResizeObserver && this._targetElement) {
      try {
        const resizeObserver = new ResizeObserver((entries) => {
          requestAnimationFrame(() => {
            if (entries.length > 0) {
              this.onContainerResize();
            }
          });
        });
        resizeObserver.observe(this._targetElement);
      } catch {
        window.addEventListener("resize", debouncedResize);
      }
    } else {
      window.addEventListener("resize", debouncedResize);
    }
  }

  public pause(): void {
    this.isPaused = true;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.state === "warping") {
      this._pauseStartTime = this.clock.getElapsedTime();
    }
    if (this.debugMode && this.performanceMonitor) {
      this.performanceMonitor.updateStatus("Paused");
    }
    this.updatePauseButtonState();
  }

  private pauseForVisibility(): void {
    if (!this.isManuallyPaused) {
      this.pause();
    }
  }

  public resume(): void {
    if (this.isPaused && !document.hidden) {
      this.isPaused = false;
      if (
        this._pauseStartTime !== undefined &&
        this._warpStartTime !== undefined
      ) {
        const pauseDuration =
          this.clock.getElapsedTime() - this._pauseStartTime;
        this._totalPausedTime += pauseDuration;
        this._warpStartTime += pauseDuration;
      }
      this._pauseStartTime = undefined;

      if (this.debugMode && this.performanceMonitor) {
        this.performanceMonitor.updateStatus("Running");
      }
      this.animate();
      this.updatePauseButtonState();
    }
  }

  public forceResume(): void {
    this.isPaused = false;
    if (
      this._pauseStartTime !== undefined &&
      this._warpStartTime !== undefined
    ) {
      const pauseDuration = this.clock.getElapsedTime() - this._pauseStartTime;
      this._totalPausedTime += pauseDuration;
      this._warpStartTime += pauseDuration;
    }
    this._pauseStartTime = undefined;

    if (this.debugMode && this.performanceMonitor) {
      this.performanceMonitor.updateStatus("Running");
    }
    this.animate();
    this.updatePauseButtonState();
  }

  private handleContextRestoration(): void {
    this._nebula?.restore();
    this._clouds?.restore();

    if (this.composer) {
      this.composer.render();
    }
  }

  public togglePause(): void {
    if (this.isPaused) {
      this.isManuallyPaused = false;
      this.resume();
    } else {
      this.isManuallyPaused = true;
      this.pause();
    }
  }

  private updatePauseButtonState(): void {
    const pauseBtn = document.getElementById("pause");
    if (pauseBtn) {
      if (this.isPaused) {
        pauseBtn.classList.add("active");
        pauseBtn.textContent = "RESUME";
      } else {
        pauseBtn.classList.remove("active");
        pauseBtn.textContent = "PAUSE";
      }
    }
  }

  // ============================================================================
  // SCENE CREATION METHODS
  // ============================================================================

  private init(): void {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, this.config.fogDensity);

    const containerRect = this._targetElement?.getBoundingClientRect();
    const width = containerRect?.width || window.innerWidth;
    const height = containerRect?.height || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    this.camera.position.z = 0;

    this.camera.layers.enable(0);
    this.camera.layers.enable(1);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });

    this.renderer.info.autoReset = false;

    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        this.pause();
      },
      false
    );

    this.renderer.domElement.addEventListener(
      "webglcontextrestored",
      () => {
        this.handleContextRestoration();
        if (!this.isManuallyPaused) {
          this.forceResume();
        }
      },
      false
    );

    this.starLayerManager = new StarLayerManager(
      this.scene,
      this.config,
      this.uniformManager
    );

    this.sceneManager = new SceneManager();

    if (
      this.config.debugMode &&
      (!this.config.gameObjects || this.config.gameObjects.length === 0)
    ) {
      this.config = this.sceneManager.create(this.config);
    }

    this.gameObjectManager = new GameObjectManager(this.scene, this.config);

    this.layerManager = new LayerManager(this);

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.domElement.style.position = "absolute";
    this.renderer.domElement.style.top = "0";
    this.renderer.domElement.style.left = "0";
    this.renderer.domElement.style.zIndex = "1";

    this.renderer.shadowMap.enabled = false;
    this.renderer.sortObjects = false;

    this._targetElement!.appendChild(this.renderer.domElement);

    this.setupPostProcessing();

    this.cameraLookAtAnimator = new CameraLookAtAnimator(
      this.camera,
      this.config,
      this.renderer.domElement
    );

    this.originTarget = new THREE.Vector3(0, 0, -200);

    this.cameraLookAtAnimator.setOriginTarget(this.originTarget);

    this.cameraLookAtLock = null;

    if (this.config.planetEnabled) {
      this._background = new Background(this.uniformManager, this.scene);
      this._background.create(this.config);
    }
    if (this.config.cloudsEnabled) {
      this._clouds = new Clouds(this.uniformManager, this.scene);
      this._clouds.create(this.config);
    }
    if (this.config.nebulaEnabled) {
      this._nebula = new Nebula(this.uniformManager, this.scene);
      this._nebula?.create(this.config);
    }

    this.starLayerManager.createStarfield();

    this.gameObjectManager.initialize();

    this.layerManager.initializeLayers();

    const firstLayer = this.starLayerManager.getFirstLayer();
    if (firstLayer) {
      this.starsGeometry = firstLayer.geometry;
      this.starsMaterial = firstLayer.material;
      this.stars = firstLayer.mesh;
      this.originalPositions = firstLayer.originalPositions;
    }
  }

  private setupPostProcessing(): void {
    const containerRect = this._targetElement?.getBoundingClientRect();
    const width = containerRect?.width || window.innerWidth;
    const height = containerRect?.height || window.innerHeight;

    this.composer = new EffectComposer(this.renderer);
    if ("multisampling" in this.composer) {
      (
        this.composer as EffectComposer & { multisampling: number }
      ).multisampling = 0;
    }

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.terminalShader = {
      uniforms: {
        tDiffuse: { value: null },
        time: { value: 0 },
        resolution: {
          value: new THREE.Vector2(width, height),
        },
        intensity: { value: this.config.terminalIntensity },
        cellSize: { value: this.config.terminalCellSize },
        characterDensity: { value: this.config.terminalCharacterDensity },
        contrast: { value: this.config.terminalContrast },
        scanlineIntensity: { value: this.config.terminalScanlineIntensity },
        scanlineFrequency: { value: this.config.terminalScanlineFrequency },
        scanlinesEnabled: { value: this.config.terminalScanlinesEnabled },
        terminalColorPrimary: {
          value: new THREE.Vector3(
            this.config.terminalColorPrimary.r,
            this.config.terminalColorPrimary.g,
            this.config.terminalColorPrimary.b
          ),
        },
        terminalColorSecondary: {
          value: new THREE.Vector3(
            this.config.terminalColorSecondary.r,
            this.config.terminalColorSecondary.g,
            this.config.terminalColorSecondary.b
          ),
        },
      },
      vertexShader: terminalVertexShader,
      fragmentShader: terminalFragmentShader,
    };

    this.terminalPass = new ShaderPass(this.terminalShader);
    this.terminalPass.enabled = !!this.config.terminalEnabled;
    this.composer.addPass(this.terminalPass);

    if (this.terminalPass && this.terminalPass.material) {
      this.uniformManager.registerMaterial(
        "terminal",
        this.terminalPass.material,
        {
          time: { type: "number" },
          resolution: { type: "vector2" },
          intensity: { type: "number", min: 0, max: 1 },
          cellSize: { type: "number", min: 1 },
          characterDensity: { type: "number", min: 0, max: 1 },
          contrast: { type: "number", min: 0 },
          scanlineIntensity: { type: "number", min: 0, max: 1 },
          scanlineFrequency: { type: "number", min: 0 },
          scanlinesEnabled: { type: "boolean" },
          terminalColorPrimary: { type: "color" },
          terminalColorSecondary: { type: "color" },
        }
      );
    }

    this.sharpenShader = {
      uniforms: {
        tDiffuse: { value: null },
        resolution: {
          value: new THREE.Vector2(width, height),
        },
        intensity: { value: this.config.sharpenIntensity || 0.5 },
        radius: { value: this.config.sharpenRadius || 1.0 },
        threshold: { value: this.config.sharpenThreshold || 0.1 },
      },
      vertexShader: sharpenVertexShader,
      fragmentShader: sharpenFragmentShader,
    };

    this.sharpenPass = new ShaderPass(this.sharpenShader);
    this.sharpenPass.enabled = !!this.config.sharpenEnabled;
    this.composer.addPass(this.sharpenPass);

    if (this.sharpenPass && this.sharpenPass.material) {
      this.uniformManager.registerMaterial(
        "sharpen",
        this.sharpenPass.material,
        {
          resolution: { type: "vector2" },
          intensity: { type: "number", min: 0, max: 2 },
          radius: { type: "number", min: 0.5, max: 3 },
          threshold: { type: "number", min: 0, max: 0.5 },
        }
      );
    }

    this.colorAdjustShader = {
      uniforms: {
        tDiffuse: { value: null },
        brightness: { value: this.config.colorAdjustBrightness || 0.0 },
        contrast: { value: this.config.colorAdjustContrast || 1.0 },
        saturation: { value: this.config.colorAdjustSaturation || 1.0 },
        gamma: { value: this.config.colorAdjustGamma || 1.0 },
        shadows: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
        midtones: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
        highlights: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      },
      vertexShader: colorAdjustVertexShader,
      fragmentShader: colorAdjustFragmentShader,
    };

    this.colorAdjustPass = new ShaderPass(this.colorAdjustShader);
    this.colorAdjustPass.enabled = !!this.config.colorAdjustEnabled;
    this.composer.addPass(this.colorAdjustPass);

    if (this.colorAdjustPass && this.colorAdjustPass.material) {
      this.uniformManager.registerMaterial(
        "colorAdjust",
        this.colorAdjustPass.material,
        {
          brightness: { type: "number", min: -1, max: 1 },
          contrast: { type: "number", min: 0, max: 3 },
          saturation: { type: "number", min: 0, max: 3 },
          gamma: { type: "number", min: 0.1, max: 3 },
          shadows: { type: "color" },
          midtones: { type: "color" },
          highlights: { type: "color" },
        }
      );
    }

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.composer.setSize(width, height);
  }

  // ============================================================================
  // STATE & ANIMATION METHODS
  // ============================================================================

  public setState(newState: StarfieldState): void {
    const nowMs = performance.now();
    this._shakeTransitionStartMs = nowMs;
    this._shakeTransitionFrom =
      this._currentShakeBlend || (this.state === "shake" ? 1 : 0);
    this._shakeTransitionTo = newState === "shake" ? 1 : 0;

    if (this.state === "warping" && newState !== "warping") {
      if (
        !this._warpCompleted &&
        this.callbacks.onWarpCancel &&
        typeof this.callbacks.onWarpCancel === "function"
      ) {
        this.callbacks.onWarpCancel();
      }

      if (!this._warpCompleted && this._warpPromiseResolver) {
        this._warpPromiseResolver(false);
        this._warpPromiseResolver = null;
      }

      this.warpTime = 0;
      this.warpPhase = "IDLE";
      this.warpProgress = 0;
      this.warpOverlay.deactivate();
      this._warpCompleted = false;
    }

    if (newState === "warping") {
      if (this.gameObjectManager) {
        const selectedObject = this.gameObjectManager.getSelectedObject();
        if (selectedObject) {
          this.gameObjectManager.deselectObject(selectedObject.id);
        }
      }

      this.clearLookAtTarget();

      this.warpTime = 0;
      this.warpElapsedSec = 0;
      this.warpPhase = "CHARGING";

      this.warpOverlay.activate();

      this._warpStartTime = this.clock.getElapsedTime();

      if (
        this.callbacks.onWarpStart &&
        typeof this.callbacks.onWarpStart === "function"
      ) {
        this.callbacks.onWarpStart();
      }
    }

    if (newState === "shake") {
      this._preShakeRotation = {
        x: this.camera.rotation.x,
        y: this.camera.rotation.y,
        z: this.camera.rotation.z,
      };
      this._cloudsShakeStartTime = this.clock.getElapsedTime();
    }

    this.state = newState;

    if (newState === "idle") {
      this.currentShakeIntensity = 0;
    }

    if (this.starLayerManager) {
      if (newState === "warping") {
        this.starLayerManager.setWarpState(true, 0, "CHARGING");
        this.starLayerManager.setShakeState(0);
      } else if (newState === "shake") {
        this.starLayerManager.setWarpState(false);
        this.starLayerManager.setShakeState(this.config.shakeIntensity || 0);
      } else {
        this.starLayerManager.setWarpState(false);
        this.starLayerManager.setShakeState(0);
      }
    }
  }

  public logConfig(): void {
    console.debug("Current Starfield Configuration:");
    console.debug("================================");

    const configCopy = JSON.parse(JSON.stringify(this.config));
    console.debug(JSON.stringify(configCopy, null, 2));

    console.debug("================================");
  }

  private updateShakeAnimation(dtSeconds: number): void {
    if (
      (this.cameraLookAtAnimator &&
        (
          this.cameraLookAtAnimator as CameraLookAtAnimator & {
            active: boolean;
          }
        ).active) ||
      this.cameraLookAtLock
    ) {
      return;
    }

    const shakeTime =
      this.clock.getElapsedTime() * this._cachedConfig.shakeSpeed;

    this.camera.position.x =
      Math.sin(shakeTime * 50) * this._cachedConfig.shakeIntensity * 0.1;
    this.camera.position.y =
      Math.cos(shakeTime * 47) * this._cachedConfig.shakeIntensity * 0.1;

    const drift = this._cachedConfig.forwardDriftShake * dtSeconds;
    if (drift > 0) {
      this.starLayerManager!.updateStarPositions(
        (positions, original, layer) => {
          const layerConfig = layer.config;
          for (let i = 2; i < positions.length; i += 3) {
            const originalZ = original[i];
            const z = positions[i] + drift;
            positions[i] = z > 10 ? originalZ - layerConfig.maxDistance : z;
          }
        }
      );
    }

    this.starLayerManager!.batchUpdateUniforms({ forwardOffset: 0 });

    const baseRot = this._preShakeRotation || { x: 0, y: 0, z: 0 };
    this.camera.rotation.x = baseRot.x;
    this.camera.rotation.y = baseRot.y;
    this.camera.rotation.z =
      baseRot.z +
      Math.sin(shakeTime * 30) * this._cachedConfig.shakeIntensity * 0.01;
  }

  private updateWarpAnimation(dtSeconds: number): void {
    if (!this._warpStartTime) {
      this._warpStartTime = this.clock.getElapsedTime();
    }
    this.warpElapsedSec = this.clock.getElapsedTime() - this._warpStartTime;

    const totalDuration = this.config.warpDurationSec || 10;

    const r = {
      CHARGING: { start: 0.0, end: 0.2 },
      BUILDUP: { start: 0.2, end: 0.5 },
      CLIMAX: { start: 0.5, end: 0.65 },
      FLASH: { start: 0.65, end: 0.85 },
      COOLDOWN: { start: 0.85, end: 1.0 },
    };
    const phases = {
      CHARGING: {
        start: totalDuration * r.CHARGING.start,
        end: totalDuration * r.CHARGING.end,
      },
      BUILDUP: {
        start: totalDuration * r.BUILDUP.start,
        end: totalDuration * r.BUILDUP.end,
      },
      CLIMAX: {
        start: totalDuration * r.CLIMAX.start,
        end: totalDuration * r.CLIMAX.end,
      },
      FLASH: {
        start: totalDuration * r.FLASH.start,
        end: totalDuration * r.FLASH.end,
      },
      COOLDOWN: {
        start: totalDuration * r.COOLDOWN.start,
        end: totalDuration * r.COOLDOWN.end,
      },
    };

    let currentPhase: WarpPhase = "CHARGING";
    let phaseProgress = 0;
    for (const [phase, timing] of Object.entries(phases)) {
      if (
        this.warpElapsedSec >= timing.start &&
        this.warpElapsedSec < timing.end
      ) {
        currentPhase = phase as WarpPhase;
        phaseProgress =
          (this.warpElapsedSec - timing.start) /
          Math.max(0.001, timing.end - timing.start);
        break;
      }
    }

    const flashElapsedTime =
      performance.now() - (this._flashHoldStartTime || 0);
    const minTimeElapsed = flashElapsedTime >= this.MIN_FLASH_HOLD_TIME;

    if (currentPhase === "COOLDOWN" && (!this._sceneReady || !minTimeElapsed)) {
      currentPhase = "FLASH";
      phaseProgress = 0.99;
    }

    if (this.warpElapsedSec >= totalDuration) {
      this.warpProgress = 0;
      this.starLayerManager!.batchUpdateUniforms({
        warpProgress: 0,
        tunnelEffect: 0,
        shakeIntensity: 0,
        forwardOffset: 0,
      });
      this.shakeIntensityMultiplier = 0;
      if (this.whiteFlash) {
        this.whiteFlash.style.opacity = "0";
      }
      this.clearLookAtTarget();

      if (this.debugMode && this._updatePhaseText) {
        this._updatePhaseText("");
      }

      this.starLayerManager!.updateStarPositions((positions, original) => {
        for (let i = 0; i < positions.length; i++) {
          positions[i] = original[i];
        }
      });

      this._nebula?.reset();

      this._warpCompleted = true;

      if (
        this.callbacks.onWarpComplete &&
        typeof this.callbacks.onWarpComplete === "function"
      ) {
        this.callbacks.onWarpComplete();
      }

      if (this._warpPromiseResolver) {
        this._warpPromiseResolver(true);
        this._warpPromiseResolver = null;
      }

      this.warpTime = 0;
      this.warpElapsedSec = 0;
      this.warpPhase = "IDLE";
      this.warpProgress = 0;
      this.tunnelEffectValue = 0;
      this.shakeIntensityMultiplier = 0;
      this.currentShakeIntensity = 0;
      this._warpStartTime = undefined;

      if (this.whiteFlash) {
        this.whiteFlash.style.opacity = "0";
      }

      this.setState("idle");
      return;
    }

    if (currentPhase === "FLASH" && this.warpPhase !== "FLASH") {
      console.debug("[STARFIELD] WARP: Transitioning to FLASH phase");
      this._flashHoldStartTime = performance.now();
      this._sceneReady = false;

      if (
        this.callbacks.onSceneIsLoading &&
        typeof this.callbacks.onSceneIsLoading === "function"
      ) {
        this.callbacks.onSceneIsLoading();
      }

      requestAnimationFrame(() => {
        const wasRendering = this._isRendering;
        if (wasRendering) {
          this._isRendering = false;
        }

        this._sceneLoadPromise = this._createNewScene()
          .then(() => {
            console.debug("[STARFIELD] WARP: Scene loaded and ready");

            // Trigger onSceneReady callback since scene is now ready
            if (
              this.callbacks.onSceneReady &&
              typeof this.callbacks.onSceneReady === "function"
            ) {
              this.callbacks.onSceneReady(
                this._isFirstRender,
                this._currentSceneId
              );
              this._isFirstRender = false;
            }

            if (wasRendering) {
              this._isRendering = true;
              this.animate();
            }
          })
          .catch((err) => {
            console.error("[STARFIELD] WARP: Scene loading failed:", err);
            // Even on failure, mark as ready to prevent infinite waiting
            this._sceneReady = true;

            if (wasRendering) {
              this._isRendering = true;
              this.animate();
            }
          });

        void this._sceneLoadPromise;
      });
    }

    this.warpPhase = currentPhase;
    if (this.debugMode && this._updatePhaseText) {
      this._updatePhaseText(
        this._phasePrefix +
          currentPhase +
          " (" +
          Math.floor(phaseProgress * 100) +
          "%)"
      );
    }

    switch (currentPhase) {
      case "CHARGING":
        this.shakeIntensityMultiplier = phaseProgress * 0.5;
        this.warpProgress = phaseProgress * 0.1;
        this.tunnelEffectValue = phaseProgress * 0.2;
        break;

      case "BUILDUP":
        this.shakeIntensityMultiplier = 0.5 + phaseProgress * 1.0;
        this.warpProgress = 0.1 + phaseProgress * 0.4;
        this.tunnelEffectValue = 0.2 + phaseProgress * 0.5;
        break;

      case "CLIMAX":
        this.shakeIntensityMultiplier = 1.2;
        this.warpProgress = 0.5 + phaseProgress * 0.5;
        this.tunnelEffectValue = 0.7 + phaseProgress * 0.3;
        this.camera.position.z = -10 - phaseProgress * 5;
        break;

      case "FLASH":
        if (this.whiteFlash) {
          // Check for timeout fallback
          const flashElapsed =
            performance.now() - (this._flashHoldStartTime || 0);
          const hasTimedOut = flashElapsed >= this.MAX_FLASH_HOLD_TIME;

          if (hasTimedOut && !this._sceneReady) {
            console.warn("[WARP] Flash hold timeout, forcing progression");
            this._sceneReady = true;

            if (
              this.callbacks.onSceneReady &&
              typeof this.callbacks.onSceneReady === "function"
            ) {
              this.callbacks.onSceneReady(
                this._isFirstRender,
                this._currentSceneId
              );
              this._isFirstRender = false;
            }
          }

          // Keep flash visible until scene is ready and minimum time elapsed
          const flashElapsedTime =
            performance.now() - (this._flashHoldStartTime || 0);
          const minTimeElapsed = flashElapsedTime >= this.MIN_FLASH_HOLD_TIME;

          if (!this._sceneReady || !minTimeElapsed) {
            this.whiteFlash.style.opacity = "1.0";
          } else {
            this.whiteFlash.style.opacity = "1.0";
          }
        }
        this.shakeIntensityMultiplier = 2.5 * (1 - phaseProgress);
        this.warpProgress = 1.0;
        this.tunnelEffectValue = 1.0;
        break;

      case "COOLDOWN":
        if (this.whiteFlash) {
          const fadeProgress = phaseProgress;
          const easedProgress =
            fadeProgress < 0.5
              ? 2 * fadeProgress * fadeProgress
              : 1 - Math.pow(-2 * fadeProgress + 2, 2) / 2;
          const fadeOutIntensity = Math.max(0, 1 - easedProgress);
          this.whiteFlash.style.opacity = fadeOutIntensity.toString();
        }
        this.shakeIntensityMultiplier = (1 - phaseProgress) * 1.0;
        this.warpProgress = 1 - phaseProgress;
        this.tunnelEffectValue = (1 - phaseProgress) * 0.5;
        break;
    }

    const shakeTime =
      this.clock.getElapsedTime() * this._cachedConfig.shakeSpeed;
    const shakeAmount =
      this._cachedConfig.shakeIntensity * this.shakeIntensityMultiplier;
    this.camera.position.x = Math.sin(shakeTime * 50) * shakeAmount * 0.1;
    this.camera.position.y = Math.cos(shakeTime * 47) * shakeAmount * 0.1;
    this.camera.rotation.z = Math.sin(shakeTime * 30) * shakeAmount * 0.01;

    this.currentShakeIntensity = shakeAmount;

    this.starLayerManager!.batchUpdateUniforms({
      warpProgress: this.warpProgress,
      shakeIntensity: shakeAmount,
      tunnelEffect: this.tunnelEffectValue,
    });

    this.starLayerManager!.updateStarPositions((positions, original, layer) => {
      const layerConfig = layer.config;
      for (let i = 0; i < positions.length; i += 3) {
        const originalZ = original[i + 2];
        positions[i + 2] = originalZ + this.warpProgress * 30 * 30;

        if (positions[i + 2] > 10) {
          positions[i + 2] = originalZ - layerConfig.maxDistance;
        }
      }
    });

    const baseFOV = 60;
    const targetFOV = this._cachedConfig.warpFOVMax;
    this.camera.fov =
      baseFOV + (targetFOV - baseFOV) * Math.pow(this.warpProgress, 0.5);
    this.camera.updateProjectionMatrix();

    this.camera.position.z = -this.warpProgress * 10;

    this.warpOverlay.update(currentPhase, phaseProgress, dtSeconds || 0);

    if (this.starLayerManager) {
      this.starLayerManager.setWarpState(true, this.warpProgress, currentPhase);
    }
  }

  // ============================================================================
  // ANIMATION LOOP
  // ============================================================================

  private animate(): void {
    if (this.isPaused || document.hidden || !this._isRendering) {
      return;
    }

    if (
      this.frameCount % 60 === 0 &&
      this.renderer.getContext().isContextLost()
    ) {
      return;
    }

    this.animationId = requestAnimationFrame(() => this.animate());

    if (this.debugMode && this.performanceMonitor) {
      this.performanceMonitor.begin();
    }

    const deltaSeconds = this.clock.getDelta();
    this.frameCount++;

    this.updateFrameUniforms();

    if (this._shakeTransitionTo !== undefined) {
      const target = this.state === "shake" ? 1 : 0;
      const blend = this._currentShakeBlend || 0;

      if (Math.abs(blend - target) > 0.001) {
        const tMs = this._shakeTransitionStartMs || 0;
        const duration = Math.max(
          0.001,
          (this.config.shakeTransitionTimeSec || 0.5) * 1000
        );
        const elapsed = performance.now() - tMs;

        if (elapsed < duration) {
          const from = this._shakeTransitionFrom || 0;
          const to = this._shakeTransitionTo;
          const k = elapsed / duration;
          const eased =
            k < 0.5
              ? 4.0 * k * k * k
              : 1.0 - Math.pow(-2.0 * k + 2.0, 3.0) / 2.0;
          this._currentShakeBlend = from + (to - from) * eased;
        } else {
          this._currentShakeBlend = target;
          this._shakeTransitionTo = undefined;
        }
      }

      if (this.state !== "warping") {
        this.currentShakeIntensity =
          this._cachedConfig.shakeIntensity * (this._currentShakeBlend || 0);
      }
    }

    if (this.state !== "warping" && this.warpProgress > 0) {
      this.warpProgress -= 0.02 * deltaSeconds;
      this.warpProgress = Math.max(0, this.warpProgress);
      this.tunnelEffectValue *= Math.pow(0.95, deltaSeconds);
      this.warpOverlay.update("COOLDOWN", 1 - this.warpProgress, deltaSeconds);

      const baseFOV = 60;
      const targetFOV = this._cachedConfig.warpFOVMax;
      const cubicEaseOut = 1 - Math.pow(1 - this.warpProgress, 3);
      this.camera.fov = baseFOV + (targetFOV - baseFOV) * cubicEaseOut;
      this.camera.updateProjectionMatrix();
      this.camera.position.z = -cubicEaseOut * 10;

      if (this.warpProgress === 0) {
        this.starLayerManager!.updateStarPositions((positions, original) => {
          for (let i = 0; i < positions.length; i++) {
            positions[i] = original[i];
          }
        });
        if (Math.abs(this.camera.fov - 60) > 0.01) {
          this.camera.fov = 60;
          this.camera.updateProjectionMatrix();
        }
        if (Math.abs(this.camera.position.z) > 0.01) {
          this.camera.position.z = 0;
        }
        if (this.warpOverlay.getIntensity() <= 0.01) {
          this.warpOverlay.deactivate();
        }
        if (this.debugMode && this._updatePhaseText) {
          this._updatePhaseText("");
        }
      }
    }

    if (this.state === "idle" && this._cachedConfig.forwardDriftIdle > 0) {
      this.currentForwardOffset =
        (this.currentForwardOffset || 0) +
        this._cachedConfig.forwardDriftIdle * deltaSeconds;
    } else if (
      this.state === "shake" &&
      this._cachedConfig.forwardDriftShake > 0
    ) {
      this.currentForwardOffset =
        (this.currentForwardOffset || 0) +
        this._cachedConfig.forwardDriftShake * deltaSeconds;
    }

    this.updateStateAnimation(deltaSeconds);

    this.updateCameraAnimation(deltaSeconds);

    this.updatePlanetPosition();

    if (this.config.renderingEnabled) {
      this.composer.render();

      if (this.debugMode) {
        this.perfStats.frameTime = deltaSeconds * 1000;
        this.perfStats.drawCalls = this.renderer.info.render.calls;
        this.perfStats.triangles = this.renderer.info.render.triangles;
        this.perfStats.programs = this.renderer.info.programs?.length || 0;
        this.perfStats.geometries = this.renderer.info.memory.geometries;
        this.perfStats.textures = this.renderer.info.memory.textures;

        this.performanceMonitor!.end();
        this.performanceMonitor!.update(
          this.perfStats.frameTime,
          this.perfStats.drawCalls,
          this.perfStats.triangles,
          this.perfStats.programs,
          this.perfStats.geometries,
          this.perfStats.textures
        );
      }

      this.renderer.info.reset();
    }
  }

  private onContainerResize(): void {
    if (!this._targetElement) {
      console.warn("Target element not available for resize");
      return;
    }

    // Get the container's dimensions
    const containerRect = this._targetElement.getBoundingClientRect();
    const newWidth = containerRect.width;
    const newHeight = containerRect.height;

    // Check if size actually changed to avoid unnecessary updates
    if (this.lastWidth === newWidth && this.lastHeight === newHeight) {
      return;
    }

    this.lastWidth = newWidth;
    this.lastHeight = newHeight;

    this.camera.aspect = newWidth / newHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(newWidth, newHeight);
    this.warpOverlay.resize(newWidth, newHeight);

    if (this.composer) {
      this.composer.setSize(newWidth, newHeight);
    }

    // Update resolution uniforms
    this._clouds?.resize(newWidth, newHeight);
    this._nebula?.resize(newWidth, newHeight);

    this.uniformManager.updateUniforms("terminal", {
      resolution: { x: newWidth, y: newHeight },
    });
    this.uniformManager.updateUniforms("sharpen", {
      resolution: { x: newWidth, y: newHeight },
    });

    // Force a render after resize to prevent black screen when paused
    if (this.isPaused && this.composer) {
      this.composer.render();
    }
  }

  // ============================================================================
  // CONFIG UPDATE
  // ============================================================================

  public updateConfig(newConfig: Partial<GalaxyStarfieldConfig>): void {
    if (!this.debugMode && this._initialLoadComplete) {
      console.warn(
        "Config updates disabled in production mode. Enable debug mode to modify settings."
      );
      return;
    }

    this.config = customDeepmerge(
      this.config,
      newConfig
    ) as GalaxyStarfieldConfig;

    this.configMapper.applyAllUpdates(newConfig, this.config);

    this.handleShadowSettings(newConfig);

    this.handleFeatureToggles(newConfig);

    if (this.starLayerManager) {
      this.starLayerManager.updateConfig(newConfig);

      const firstLayer = this.starLayerManager.getFirstLayer();
      if (firstLayer) {
        this.originalPositions = firstLayer.originalPositions;
      }
    }

    if (this.gameObjectManager) {
      this.gameObjectManager.updateConfig(newConfig);
    }

    this.updateCachedConfig();
  }

  private handleShadowSettings(
    newConfig: Partial<GalaxyStarfieldConfig>
  ): void {
    const shadowConfigs = [
      "planetShadowEnabled",
      "planetShadowRadius",
      "planetShadowOpacity",
      "planetShadowSoftness",
      "planetScale",
    ];

    if (shadowConfigs.some((key) => key in newConfig) && this.shadowManager) {
      this.shadowManager.updateShadowSettings(this.config);
    }
  }

  private handleFeatureToggles(
    newConfig: Partial<GalaxyStarfieldConfig>
  ): void {
    if ("cloudsEnabled" in newConfig) {
      this._clouds?.toggle(this.config.cloudsEnabled);
    }
    if ("nebulaEnabled" in newConfig) {
      this._nebula?.toggle(this.config.nebulaEnabled);
    }
    if ("terminalEnabled" in newConfig && this.terminalPass) {
      this.terminalPass.enabled = this.config.terminalEnabled;
    }
    if ("sharpenEnabled" in newConfig && this.sharpenPass) {
      this.sharpenPass.enabled = this.config.sharpenEnabled;
    }
    if ("colorAdjustEnabled" in newConfig && this.colorAdjustPass) {
      this.colorAdjustPass.enabled = this.config.colorAdjustEnabled;
    }
  }

  // ============================================================================
  // PUBLIC API METHODS
  // ============================================================================

  /**
   * Get the current configuration
   * @returns {Object} Current configuration object
   */
  public getConfig(): GalaxyStarfieldConfig {
    return { ...this.config };
  }

  /**
   * Update configuration with new values
   * @param {Object} newConfig - Configuration updates to apply
   */
  public setConfig(newConfig: Partial<GalaxyStarfieldConfig>): void {
    this.updateConfig(newConfig);
  }

  /**
   * Get the current animation state
   * @returns {string} Current state ('idle', 'shake', 'warping')
   */
  public getState(): StarfieldState {
    return this.state;
  }

  /**
   * Set the animation state
   * @param {string} newState - New state to transition to
   */
  public setAnimationState(newState: StarfieldState): void {
    this.setState(newState);
  }

  /**
   * Start warp animation
   */
  public startWarp(): void {
    if (this.state === "warping") {
      this.warpTime = 0;
      this.warpElapsedSec = 0;
      this.warpPhase = "IDLE";
      this.warpProgress = 0;
      this.tunnelEffectValue = 0;
      this.shakeIntensityMultiplier = 0;
      this.currentShakeIntensity = 0;
      this._warpCompleted = false;
    }

    this.setAnimationState("warping");
  }

  /**
   * Warp to a specific sector with optional configuration
   */
  public async warpToSector(options: WarpOptions): Promise<boolean> {
    if (!this.sceneManager) {
      console.warn("[STARFIELD] SceneManager not available");
      return false;
    }

    const {
      id,
      gameObjects = [],
      sceneConfig,
      bypassAnimation = false,
      bypassFlash = true,
      bypassCooldown = false,
    } = options;

    if (!id) {
      console.warn("[STARFIELD] Sector ID is required");
      return false;
    }

    if (this._currentSceneId === id) {
      return true;
    }

    // Handle warp cooldown
    const isInCooldown = this._handleWarpCooldown(
      bypassAnimation,
      bypassCooldown
    );

    this._pendingSectorConfig = this.sceneManager.prepareSceneVariant(
      id,
      sceneConfig,
      gameObjects,
      this.gameObjectManager || null
    );

    if (
      this.state === "warping" &&
      this.warpPhase !== "FLASH" &&
      this.warpPhase !== "COOLDOWN" &&
      this.warpPhase !== "IDLE"
    ) {
      this._currentSceneId = id;

      return new Promise<boolean>((resolve) => {
        this._warpPromiseResolver = resolve;
      });
    }

    this.clearGameObjectSelection();

    const warpPromise = new Promise<boolean>((resolve) => {
      this._warpPromiseResolver = resolve;
    });

    if (!this._currentSceneId || bypassAnimation || isInCooldown) {
      const configToLoad = this._pendingSectorConfig;
      this._pendingSectorConfig = null;
      this._loadSceneWithReadyState(configToLoad, true, !bypassFlash)
        .then(() => {
          if (this._warpPromiseResolver) {
            this._warpPromiseResolver(true);
            this._warpPromiseResolver = null;
          }
        })
        .catch((err) => {
          console.error("[STARFIELD] Scene loading failed:", err);
          if (this._warpPromiseResolver) {
            this._warpPromiseResolver(false);
            this._warpPromiseResolver = null;
          }
        });
    } else {
      this.startWarp();
    }

    this._currentSceneId = id;

    this.startRendering();

    return warpPromise;
  }

  /**
   * Check if a sector exists
   */
  public hasSector(sectorId: string): boolean {
    return this.sceneManager
      ? this.sceneManager.hasNamedConfig(sectorId)
      : false;
  }

  /**
   * Get sector information
   */
  public getSector(sectorId: string): Partial<GalaxyStarfieldConfig> | null {
    return this.sceneManager
      ? this.sceneManager.getNamedConfig(sectorId)
      : null;
  }

  /**
   * Get all available sector IDs
   */
  public getSectorIds(): string[] {
    return this.sceneManager ? this.sceneManager.getNamedConfigIds() : [];
  }

  /**
   * Get the current active scene ID
   */
  public getCurrentSceneId(): string | null {
    return this._currentSceneId;
  }

  /**
   * Set the current scene ID (useful for initial scene setup)
   */
  public setCurrentSceneId(sceneId: string): void {
    this._currentSceneId = sceneId;
  }

  /**
   * Start shake animation
   */
  public startShake(): void {
    this.setAnimationState("shake");
  }

  /**
   * Return to idle state
   */
  public setIdle(): void {
    this.setAnimationState("idle");
  }

  /**
   * Pause the animation
   */
  public pauseAnimation(): void {
    this.pause();
  }

  /**
   * Resume the animation
   */
  public resumeAnimation(): void {
    this.resume();
  }

  /**
   * Clear the warp cooldown timer manually
   */
  public clearWarpCooldown(): void {
    if (this._warpCooldownTimer !== null) {
      console.debug("[STARFIELD] Manually clearing cooldown timer");
      clearTimeout(this._warpCooldownTimer);
      this._warpCooldownTimer = null;
    }
  }

  /**
   * Check if the warp system is currently in cooldown
   * @returns {boolean} True if in cooldown, false otherwise
   */
  public get isWarpCooldownActive(): boolean {
    return this._warpCooldownTimer !== null;
  }

  // ============================================================================
  // GAME OBJECT API METHODS
  // ============================================================================

  /**
   * Select a game object by ID with async look-at animation
   */
  public async selectGameObject(
    objectId: string,
    options: SelectionOptions = {}
  ): Promise<boolean> {
    if (!this.gameObjectManager) {
      console.warn("GameObjectManager not available");
      return false;
    }

    const success = this.gameObjectManager.selectObject(objectId);

    if (success && objectId) {
      if (this.layerManager && this.config.layerDimmingEnabled) {
        this.layerManager.startDimming();
      }

      if (
        this.callbacks.onGameObjectSelected &&
        typeof this.callbacks.onGameObjectSelected === "function"
      ) {
        const gameObject = this.gameObjectManager.getObject(objectId);
        if (gameObject) {
          this.callbacks.onGameObjectSelected(gameObject);
        }
      }

      const defaultOptions = {
        zoomFactor: this.config.cameraZoomFactor,
        ...options,
      };

      // Perform the look-at animation and wait for completion
      return await this.lookAtGameObject(objectId, defaultOptions);
    }

    return success;
  }

  /**
   * Clear the currently selected game object
   */
  public clearGameObjectSelection(): boolean {
    if (this.gameObjectManager) {
      const selectedObject = this.gameObjectManager.getSelectedObject();
      if (selectedObject) {
        this.gameObjectManager.deselectObject(selectedObject.id);

        if (this.layerManager && this.config.layerDimmingEnabled) {
          this.layerManager.startRestoration();
        }

        this.clearLookAtTarget();

        if (
          this.callbacks.onGameObjectCleared &&
          typeof this.callbacks.onGameObjectCleared === "function"
        ) {
          this.callbacks.onGameObjectCleared();
        }

        return true;
      }
    }
    return false;
  }

  /**
   * Get all game objects
   */
  public getAllGameObjects(): GameObjectInstance[] {
    if (this.gameObjectManager) {
      return this.gameObjectManager.getAllObjects();
    }
    return [];
  }

  /**
   * Get game objects by type
   */
  public getGameObjectsByType(
    type: keyof GameObjectTypes
  ): GameObjectInstance[] {
    if (this.gameObjectManager) {
      return this.gameObjectManager.getObjectsByType(type);
    }
    return [];
  }

  /**
   * Look at a specific game object with smooth animation (private method)
   */
  private async lookAtGameObject(
    objectId: string,
    options: LookAtOptions = {}
  ): Promise<boolean> {
    if (!this.gameObjectManager) {
      console.warn("GameObjectManager not available");
      return false;
    }

    const gameObject = this.gameObjectManager.getObject(objectId);
    if (!gameObject) {
      console.warn(`Game object ${objectId} not found`);
      return false;
    }

    if (this.cameraLookAtAnimator) {
      return new Promise<boolean>((resolve) => {
        this.cameraLookAtAnimator!.lookAtGameObject(gameObject.mesh, {
          ...options,
          onComplete: () => {
            this.cameraLookAtLock = null;

            if (
              this.callbacks.onGameObjectInView &&
              typeof this.callbacks.onGameObjectInView === "function"
            ) {
              this.callbacks.onGameObjectInView(gameObject);
            }

            resolve(true);
          },
        });

        this.cameraLookAtLock = { mesh: gameObject.mesh };
      });
    }

    return true;
  }

  /**
   * Clear the look-at target, returning to origin
   */
  private clearLookAtTarget(): void {
    if (this.cameraLookAtAnimator && this.originTarget) {
      this.cameraLookAtAnimator.returnToOrigin(this.originTarget);
    }

    this.cameraLookAtLock = null;
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get the renderer canvas element
   */
  public getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * Get performance statistics
   */
  public getPerformanceStats(): PerformanceStats | null {
    if (!this.debugMode) {
      console.warn("Performance stats are only available in debug mode");
      return null;
    }
    return { ...this.perfStats };
  }

  /**
   * Calculate clouds shake progress for smooth transitions
   */
  public getCloudsShakeProgress(): number {
    if (this.state !== "shake" || !this._cloudsShakeStartTime) {
      return 0;
    }
    const elapsed = this.clock.getElapsedTime() - this._cloudsShakeStartTime;
    const rampTime = this.config.cloudsShakeWarpRampTime || 4.0;
    const progress = Math.min(elapsed / rampTime, 1.0);
    return progress;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private updateCachedConfig(): void {
    this._cachedConfig.shakeIntensity = this.config.shakeIntensity || 0;
    this._cachedConfig.shakeSpeed = this.config.shakeSpeed || 1;
    // Legacy config properties (not in current type definition)
    const extendedConfig = this.config as unknown as Record<string, unknown>;
    this._cachedConfig.forwardDriftIdle =
      (extendedConfig.forwardDriftIdle as number) || 0;
    this._cachedConfig.forwardDriftShake =
      (extendedConfig.forwardDriftShake as number) || 0;
    this._cachedConfig.idleSwayRandomSpeed =
      (extendedConfig.idleSwayRandomSpeed as number) || 0.2;
    this._cachedConfig.idleSwayRandomIntensity =
      (extendedConfig.idleSwayRandomIntensity as number) || 0.1;
    this._cachedConfig.warpFOVMax = this.config.warpFOVMax || 60;
  }

  private updateFrameUniforms(): void {
    this.uniformManager.updateGlobalTimeUniforms(this.clock.getElapsedTime());

    this._frameState.currentState = this.state;
    this._frameState.currentShakeIntensity = this.currentShakeIntensity || 0;
    this._frameState.shakePhase = this.clock.getElapsedTime();
    this._frameState.cloudsShakeProgress = this.getCloudsShakeProgress();
    this._frameState.warpProgress = this.warpProgress || 0;
    this._frameState.tunnelEffectValue = this.tunnelEffectValue || 0;
    this._frameState.warpPhase = this.warpPhase;
    this._frameState.cameraRotation.x = this.camera.rotation.x;
    this._frameState.cameraRotation.y = this.camera.rotation.y;
    this._frameState.cameraRotation.z = this.camera.rotation.z;

    const dimmingFactors = this.layerManager?.getDimmingFactors();

    const updates = this.configMapper.getFrameUpdates(
      this._frameState,
      this.config,
      dimmingFactors
    );

    this.batchUniformUpdates(updates);

    if (this.shadowManager?.shouldUpdateShadowCenter()) {
      this.shadowManager.updateShadowCenter(this.camera);
    }

    if (this.shadowManager && this._background?.getPlanetGroup()) {
      const currentPlanetGroup = this.shadowManager.getPlanetGroup();
      const newPlanetGroup = this._background.getPlanetGroup()!;

      if (!currentPlanetGroup || currentPlanetGroup !== newPlanetGroup) {
        this.shadowManager.setPlanetGroup(
          newPlanetGroup,
          this._background.getPlanetRandomOffset()!
        );

        this.shadowManager.applyInitialSettings();
      }
    }
  }

  private batchUniformUpdates(
    configUpdates: Record<string, Record<string, unknown>>
  ): void {
    const starLayerUniforms = {
      shakeIntensity: this.currentShakeIntensity || 0,
      warpProgress: this.warpProgress || 0,
      tunnelEffect: this.tunnelEffectValue || 0,
      forwardOffset: this.currentForwardOffset || 0,
    };

    let starLayerUniformsChanged = false;
    Object.entries(starLayerUniforms).forEach(([key, value]) => {
      const cachedKey = key as keyof CachedUniforms;
      if (this._cachedUniforms[cachedKey] !== value) {
        (this._cachedUniforms[cachedKey] as number) = value;
        starLayerUniformsChanged = true;
      }
    });

    Object.entries(configUpdates).forEach(([materialId, uniforms]) => {
      if (
        uniforms &&
        Object.keys(uniforms).length > 0 &&
        this.uniformManager.hasMaterial(materialId)
      ) {
        this.uniformManager.updateUniforms(
          materialId,
          uniforms as Record<string, unknown>
        );
      }
    });

    if (starLayerUniformsChanged) {
      this.starLayerManager!.batchUpdateUniforms(starLayerUniforms);
    }

    if (this.gameObjectManager) {
      this.gameObjectManager.updateRotations();
    }

    if (this.layerManager) {
      this.layerManager.updateDimAnimation(this.clock.getElapsedTime());
    }
  }

  private updateStateAnimation(deltaSeconds: number): void {
    const handlers = {
      idle: () => {},
      shake: () => this.updateShakeAnimation(deltaSeconds),
      warping: () => this.updateWarpAnimation(deltaSeconds),
    };

    const handler = handlers[this.state];
    if (handler) handler();
  }

  private updatePlanetPosition(): void {
    if (this._background) {
      this._background.updatePlanetPosition(this.camera.position);

      // Notify ShadowManager that planet transform has changed
      if (this.shadowManager) {
        this.shadowManager.markPlanetTransformDirty();
      }
    }
  }

  private updateCameraAnimation(deltaSeconds: number): void {
    if (this.cameraLookAtAnimator) {
      this.cameraLookAtAnimator.update(deltaSeconds);
    }
  }

  /**
   * Reload configuration and update the scene
   */
  public async reloadConfig(
    newConfig: Partial<GalaxyStarfieldConfig> | null = null
  ): Promise<void> {
    if (newConfig) {
      this.config = { ...this.config, ...newConfig };
    }

    this.updateCachedConfig();

    // Recreate game objects if needed
    if (this.gameObjectManager) {
      this.gameObjectManager.updateConfig(this.config);
    }

    // Update star layers with new config
    if (this.starLayerManager) {
      this.starLayerManager.updateConfig(this.config);
    }

    // Update visual elements that need recreation
    const promises: Promise<void>[] = [];

    if (this.config.planetEnabled && this._background) {
      promises.push(this._background.create(this.config));
      this.shadowManager?.onSceneChange();
    }

    if (this.config.nebulaEnabled) {
      this._nebula?.create(this.config);
    }

    if (this.config.cloudsEnabled) {
      this._clouds?.create(this.config);
    }

    // Wait for all async operations (primarily Background texture loading)
    await Promise.all(promises);

    // Update star layers with new properties
    /*if (this.starLayerManager) {
      console.debug("Updating star layers with new properties");

      // Recreate star layers with new config
      this.starLayerManager.destroyAllLayers();
      this.starLayerManager.createStarfield();
    }*/

    if (this.controlsManager) {
      this.controlsManager.refresh();
    }
  }

  /**
   * Unified scene loading method that handles both async loading and ready state detection
   * @private
   */
  private async _loadSceneWithReadyState(
    newConfig: Partial<GalaxyStarfieldConfig> | null = null,
    triggerCallbacks: boolean = true,
    transition: boolean = false
  ): Promise<void> {
    if (
      triggerCallbacks &&
      this.callbacks.onSceneIsLoading &&
      typeof this.callbacks.onSceneIsLoading === "function"
    ) {
      this.callbacks.onSceneIsLoading();
    }

    if (transition && this.whiteFlash) {
      this.whiteFlash.style.opacity = "1.0";
      const flashStartTime = performance.now();

      await this.reloadConfig(newConfig);

      await this._waitForSceneReadyState();

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

      await this._fadeOutWhiteFlash(200);
    } else {
      await this.reloadConfig(newConfig);
      await this._waitForSceneReadyState();
    }

    if (
      triggerCallbacks &&
      this.callbacks.onSceneReady &&
      typeof this.callbacks.onSceneReady === "function"
    ) {
      this.callbacks.onSceneReady(this._isFirstRender, this._currentSceneId);
      this._isFirstRender = false;
    }
  }

  /**
   * Wait for scene to be fully ready (includes settling period and minimum wait time)
   * This ensures consistent behavior between warp animation and direct reload paths
   * @private
   */
  private async _waitForSceneReadyState(): Promise<void> {
    // Start the settling period
    this._sceneSettleStartTime = performance.now();

    // Wait for the settling duration
    await new Promise<void>((resolve) => {
      const checkSettling = () => {
        const settleElapsed =
          performance.now() - (this._sceneSettleStartTime || 0);
        if (settleElapsed >= this.SCENE_SETTLE_DURATION) {
          resolve();
        } else {
          requestAnimationFrame(checkSettling);
        }
      };
      checkSettling();
    });

    // Mark scene as ready
    this._sceneReady = true;
  }

  /**
   * Fade out the white flash element with easing
   * @private
   */
  private async _fadeOutWhiteFlash(duration: number = 200): Promise<void> {
    if (!this.whiteFlash) return;

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

        if (this.whiteFlash) {
          this.whiteFlash.style.opacity = opacity.toString();
        }

        if (fadeProgress < 1) {
          requestAnimationFrame(fadeOut);
        } else {
          resolve();
        }
      };
      fadeOut();
    });
  }

  /**
   * Handle warp cooldown logic with debouncing
   * @private
   */
  private _handleWarpCooldown(
    bypassAnimation: boolean,
    bypassCooldown: boolean
  ): boolean {
    const warpCooldownSec = this.config.warpCooldownSec || 0;
    const isInCooldown = this._warpCooldownTimer !== null;

    if (bypassCooldown) {
      console.debug("[STARFIELD] Bypassing cooldown timer");
      if (this._warpCooldownTimer !== null) {
        clearTimeout(this._warpCooldownTimer);
        this._warpCooldownTimer = null;
      }
      return false;
    }

    if (this._warpCooldownTimer !== null) {
      console.debug("[STARFIELD] Resetting cooldown timer (debounce)");
      clearTimeout(this._warpCooldownTimer);
    }

    if (!bypassAnimation && warpCooldownSec > 0) {
      console.debug(
        `[STARFIELD] Starting cooldown timer for ${warpCooldownSec}s`
      );
      this._warpCooldownTimer = window.setTimeout(() => {
        console.debug("[STARFIELD] Cooldown timer expired");
        this._warpCooldownTimer = null;
      }, warpCooldownSec * 1000);
    }

    if (isInCooldown) {
      console.debug(
        "[STARFIELD] Currently in cooldown - forcing bypass animation"
      );
    }

    return isInCooldown;
  }

  /**
   * Create a new scene using the SceneManager
   * @private
   */
  private async _createNewScene(): Promise<void> {
    if (!this.sceneManager) {
      console.warn("[STARFIELD] SceneManager not available");
      return;
    }

    await new Promise((resolve) =>
      requestAnimationFrame(() => resolve(undefined))
    );

    let newConfig;

    if (this._pendingSectorConfig) {
      newConfig = this._pendingSectorConfig;
      this._pendingSectorConfig = null;
    } else {
      newConfig = this.sceneManager.create(this.config);
    }

    await this._loadSceneWithReadyState(newConfig, false, false);
  }

  // ============================================================================
  // CLEANUP METHODS
  // ============================================================================

  public destroy(): void {
    if (this.uniformManager) {
      this.uniformManager.resetCache();
    }
    if (this.starLayerManager) {
      this.starLayerManager.destroyAllLayers();
    }
    if (this.gameObjectManager) {
      this.gameObjectManager.dispose();
    }
    if (this.cameraLookAtAnimator) {
      this.cameraLookAtAnimator.dispose();
    }

    this.renderer.dispose();
    document.body.removeChild(this.renderer.domElement);
  }

  // ============================================================================
  // RENDER CONTROL METHODS
  // ============================================================================

  /**
   * Start rendering the scene
   */
  public startRendering(): void {
    if (this._isRendering) return;

    this._isRendering = true;

    this.animate();
  }

  /**
   * Stop rendering the scene
   */
  public stopRendering(): void {
    this._isRendering = false;
  }

  /**
   * Check if rendering is active
   */
  public isRendering(): boolean {
    return this._isRendering;
  }

  /**
   * Initialize scene and start rendering
   */
  public async initializeScene(): Promise<void> {
    if (!this.config.gameObjects || this.config.gameObjects.length === 0) {
      this.config = this.sceneManager!.create(this.config);
    }

    this._currentSceneId = "initial";

    await this._waitForSceneReady();

    this.startRendering();

    if (
      this.callbacks.onSceneReady &&
      typeof this.callbacks.onSceneReady === "function"
    ) {
      this.callbacks.onSceneReady(this._isFirstRender, this._currentSceneId);
      this._isFirstRender = false;
    }
  }

  /**
   * Wait for heavy scene initialization to complete
   * @private
   */
  private async _waitForSceneReady(): Promise<void> {
    if (this.config.planetEnabled && this._background) {
      await new Promise<void>((resolve) => {
        const checkPlanetReady = () => {
          if (this._background?.getPlanetGroup()) {
            resolve();
          } else {
            requestAnimationFrame(checkPlanetReady);
          }
        };
        checkPlanetReady();
      });
    }

    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(undefined);
      });
    });
  }
}
