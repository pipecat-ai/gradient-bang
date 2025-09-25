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
import { PerformanceMonitor } from "./PerformanceMonitor";
import { CameraLookAtAnimator } from "./animations/CameraLookAt";
import { WarpOverlay } from "./animations/WarpOverlay";
import { ControlsManager } from "./managers/ControlsManager";
import { GameObjectManager } from "./managers/GameObjectManager";
import { LayerManager } from "./managers/LayerManager";
import { SceneManager } from "./managers/SceneManager";
import { StarLayerManager } from "./managers/StarLayerManager";
import { UniformManager } from "./managers/UniformManager";

import {
  DEFAULT_GALAXY_CONFIG,
  type GalaxyStarfieldConfig,
  type WarpPhase,
} from "./constants";

import {
  type GameObjectBaseConfig,
  type GameObjectInstance,
  type GameObjectTypes,
} from "./types/GameObject";

import customDeepmerge from "./utils/merge";

import { Background, Clouds, Nebula } from "./fx";
import { ShadowManager } from "./managers/ShadowManager";

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
  onSceneReady?: (() => void) | null;
}

/** Frame state for animation loop */
export interface FrameState {
  currentState: StarfieldState;
  currentShakeIntensity: number;
  shakePhase: number;
  cloudsShakeProgress: number;
  warpProgress: number;
  tunnelEffectValue: number;
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
  [key: string]: any;
}

/** Look at animation options */
export interface LookAtOptions {
  duration?: number;
  zoom?: boolean;
  easing?: string;
  zoomFactor?: number;
  onComplete?: () => void;
  [key: string]: any;
}

/** Warp destination options */
export interface WarpOptions {
  id?: string;
  name?: string;
  config?: Partial<GalaxyStarfieldConfig>;
  gameObjects?: GameObjectBaseConfig[];
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

  // Pending sector config for warping
  private _pendingSectorConfig: Partial<GalaxyStarfieldConfig> | null;

  // Current active scene ID
  private _currentSceneId: string | null;

  // Reusable objects to prevent garbage collection
  private _frameState: FrameState;

  // Cached uniform values for batching optimization
  private _cachedUniforms: CachedUniforms;

  // Cached frequently accessed config values for performance
  private _cachedConfig: CachedConfig;

  // Performance monitoring
  public perfStats: PerformanceStats;

  // Manager instances
  public controlsManager: ControlsManager | null;
  public uniformManager: UniformManager;
  public configMapper: ConfigUniformMapper;
  public warpOverlay: WarpOverlay;
  public performanceMonitor?: PerformanceMonitor | null;
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
  public terminalShader?: any;
  public sharpenShader?: any;
  public colorAdjustShader?: any;
  public outputPass?: any;

  public starsGeometry?: THREE.BufferGeometry;
  public starsMaterial?: THREE.ShaderMaterial;
  public stars?: THREE.Points;
  public originalPositions?: Float32Array;
  public originTarget?: THREE.Vector3;
  public cameraLookAtLock?: any;

  // DOM elements
  public whiteFlash?: HTMLElement | null;
  private _targetElement?: HTMLElement | null;

  // Private animation state
  private _warpStartTime?: number;
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
    // Initialize with container dimensions (fallback to window if container not ready)
    const containerRect = this._targetElement?.getBoundingClientRect();
    this.lastWidth = containerRect?.width || window.innerWidth;
    this.lastHeight = containerRect?.height || window.innerHeight;

    // Visibility and pause state management
    this.isPaused = false;
    this.isManuallyPaused = false;
    this.animationId = null;

    // Pending sector config for warping
    this._pendingSectorConfig = null;

    // Current active scene ID
    this._currentSceneId = null;

    // Reusable frameState object to prevent allocation in animation loop
    this._frameState = {
      currentState: "idle",
      currentShakeIntensity: 0,
      shakePhase: 0,
      cloudsShakeProgress: 0,
      warpProgress: 0,
      tunnelEffectValue: 0,
      cameraRotation: { x: 0, y: 0, z: 0 },
    };

    // Cached uniform values for batching optimization
    this._cachedUniforms = {
      shakeIntensity: 0,
      warpProgress: 0,
      tunnelEffect: 0,
      forwardOffset: 0,
    };

    // Cached frequently accessed config values for performance
    this._cachedConfig = {
      shakeIntensity: 0,
      shakeSpeed: 0,
      forwardDriftIdle: 0,
      forwardDriftShake: 0,
      idleSwayRandomSpeed: 0,
      idleSwayRandomIntensity: 0,
      warpFOVMax: 60,
    };

    // Performance monitoring
    this.perfStats = {
      drawCalls: 0,
      triangles: 0,
      programs: 0,
      frameTime: 0,
      lastFrameStart: 0,
    };

    // Controls manager (only created in debug mode)
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

    // Don't start rendering immediately - wait for scene configuration
    // this.animate();

    // Initialize controls manager if starting in debug mode
    if (this.debugMode) {
      this.controlsManager = new ControlsManager(this);
    }

    this._initialLoadComplete = true;
  }

  // ============================================================================
  // DEBUG MODE CONTROL
  // ============================================================================

  /**
   * Enable debug mode - shows HUD, enables performance monitoring, allows config updates
   */
  public enableDebugMode(): void {
    if (this.debugMode) return;

    this.debugMode = true;
    console.debug("Debug mode enabled");

    if (!this.controlsManager) {
      this.controlsManager = new ControlsManager(this);
    }

    // Create performance monitor if it doesn't exist
    if (!this.performanceMonitor) {
      this.performanceMonitor = new PerformanceMonitor(
        this.renderer,
        this.scene
      );
    }
  }

  /**
   * Disable debug mode - hides HUD, disables performance monitoring, prevents config updates
   */
  public disableDebugMode(): void {
    if (!this.debugMode) return;

    this.debugMode = false;
    console.debug("Debug mode disabled - production mode active");

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
  public toggleDebugMode(): void {
    if (this.debugMode) {
      this.disableDebugMode();
    } else {
      this.enableDebugMode();
    }
  }

  // ============================================================================
  // VISIBILITY & PAUSE MANAGEMENT
  // ============================================================================

  private initVisibilityHandling(): void {
    // Handle tab visibility changes
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        console.debug("Document hidden, pausing animation");
        this.pauseForVisibility();
        if (this.debugMode && this.performanceMonitor) {
          this.performanceMonitor.updateStatus("Paused");
        }
      } else {
        console.debug("Document visible, resuming animation");
        if (!this.isManuallyPaused) {
          this.forceResume();
        } else {
          console.debug("Document visible but manually paused, not resuming");
        }
      }
    });

    // Handle window blur/focus for additional power savings
    window.addEventListener("blur", () => {
      if (!this.isPaused) {
        console.debug("Window blurred, pausing animation");
        this.pauseForVisibility();
        if (this.debugMode && this.performanceMonitor) {
          this.performanceMonitor.updateStatus("Paused");
        }
      }
    });

    window.addEventListener("focus", () => {
      if (!document.hidden && !this.isManuallyPaused) {
        console.debug("Window focused, resuming animation");
        this.forceResume();
      } else if (!document.hidden && this.isManuallyPaused) {
        console.debug("Window focused but manually paused, not resuming");
      } else {
        console.debug("Window focused but document still hidden, not resuming");
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

    // Use ResizeObserver to watch the target container element
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
        console.debug("ResizeObserver initialized for target container");
      } catch (e) {
        console.debug(
          "ResizeObserver not fully supported, falling back to window resize"
        );
        window.addEventListener("resize", debouncedResize);
      }
    } else {
      // Fallback to window resize if ResizeObserver is not available
      console.debug("ResizeObserver not available, using window resize");
      window.addEventListener("resize", debouncedResize);
    }
  }

  public pause(): void {
    this.isPaused = true;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.debugMode && this.performanceMonitor) {
      this.performanceMonitor.updateStatus("Paused");
    }
    this.updatePauseButtonState();
  }

  private pauseForVisibility(): void {
    if (!this.isManuallyPaused) {
      console.debug("Visibility pause - not manually paused, pausing");
      this.pause();
    } else {
      console.debug("Visibility pause - manually paused, not pausing");
    }
  }

  public resume(): void {
    if (this.isPaused && !document.hidden) {
      this.isPaused = false;
      if (this.debugMode && this.performanceMonitor) {
        this.performanceMonitor.updateStatus("Running");
      }
      this.animate();
      this.updatePauseButtonState();
    }
  }

  public forceResume(): void {
    this.isPaused = false;
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
      console.debug("Manual pause cleared, resuming");
      this.resume();
    } else {
      this.isManuallyPaused = true;
      console.debug("Manual pause set, pausing");
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
    // Create scene
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, this.config.fogDensity);

    // Create camera with container dimensions (fallback to window if container not ready)
    const containerRect = this._targetElement?.getBoundingClientRect();
    const width = containerRect?.width || window.innerWidth;
    const height = containerRect?.height || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    this.camera.position.z = 0;

    // Configure camera to see both layers: 0 (stars) and 1 (background/mask)
    this.camera.layers.enable(0);
    this.camera.layers.enable(1);

    // Create renderer with pixel-perfect settings
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });

    // Configure renderer for accurate performance stats
    this.renderer.info.autoReset = false;

    // Handle WebGL context loss/restoration
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        console.debug("WebGL context lost");
        this.pause();
      },
      false
    );

    this.renderer.domElement.addEventListener(
      "webglcontextrestored",
      () => {
        console.debug("WebGL context restored");
        this.handleContextRestoration();
        if (!this.isManuallyPaused) {
          this.forceResume();
        } else {
          console.debug(
            "WebGL context restored but manually paused, not resuming"
          );
        }
      },
      false
    );

    // Initialize performance monitor only if debug mode is enabled
    if (this.debugMode) {
      this.performanceMonitor = new PerformanceMonitor(
        this.renderer,
        this.scene
      );
    }

    // Initialize star layer manager (UniformManager is REQUIRED)
    this.starLayerManager = new StarLayerManager(
      this.scene,
      this.config,
      this.uniformManager
    );

    // Initialize scene manager for scene generation
    this.sceneManager = new SceneManager();

    // If this is the initial load and we need game objects, generate them
    if (
      this.config.debugMode &&
      (!this.config.gameObjects || this.config.gameObjects.length === 0)
    ) {
      console.debug("Generating initial game objects for debug mode");
      this.config = this.sceneManager.create(this.config);
    }

    // Initialize game object manager
    this.gameObjectManager = new GameObjectManager(this.scene, this.config);

    // Initialize layer manager for dimming functionality
    this.layerManager = new LayerManager(this);
    console.debug("Starfield: LayerManager initialized:", !!this.layerManager);

    // Ensure correct color management with modern Three.js
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.domElement.style.position = "absolute";
    this.renderer.domElement.style.top = "0";
    this.renderer.domElement.style.left = "0";
    this.renderer.domElement.style.zIndex = "1";

    // Disable texture filtering for pixel art look
    this.renderer.shadowMap.enabled = false;
    this.renderer.sortObjects = false;

    this._targetElement!.appendChild(this.renderer.domElement);

    // Setup post-processing after renderer is ready
    this.setupPostProcessing();

    // Initialize unified camera look-at animator with config and renderer DOM element
    this.cameraLookAtAnimator = new CameraLookAtAnimator(
      this.camera,
      this.config,
      this.renderer.domElement
    );

    // Set a default origin target for the starfield scene
    this.originTarget = new THREE.Vector3(0, 0, -200);

    // Set the origin target in the camera animator
    this.cameraLookAtAnimator.setOriginTarget(this.originTarget);

    // Legacy compatibility
    this.cameraLookAtLock = null;

    // Create background layers
    if (this.config.planetEnabled) {
      this._background = new Background(this.uniformManager, this.scene);
      this._background.create(this.config);

      // Note: Planet group will be set asynchronously when texture loads
      console.debug(
        "[Starfield] Background created, planet group will be set when texture loads"
      );
    }
    if (this.config.cloudsEnabled) {
      this._clouds = new Clouds(this.uniformManager, this.scene);
      this._clouds.create(this.config);
    }
    if (this.config.nebulaEnabled) {
      // Create nebula
      this._nebula = new Nebula(this.uniformManager, this.scene);
      this._nebula?.create(this.config);
    }

    // Note: Shadow settings will be applied when planet group becomes available
    console.debug(
      "[Starfield] All materials created, shadow settings will be applied when planet group is ready"
    );

    // Create starfield layers for depth
    this.starLayerManager.createStarfield();

    // Initialize game objects
    this.gameObjectManager.initialize();

    // Initialize layer manager after all layers are created
    this.layerManager.initializeLayers();

    // Store original positions for effects (backward compatibility)
    const firstLayer = this.starLayerManager.getFirstLayer();
    if (firstLayer) {
      this.starsGeometry = firstLayer.geometry;
      this.starsMaterial = firstLayer.material;
      this.stars = firstLayer.mesh;
      this.originalPositions = firstLayer.originalPositions;
    }
  }

  private setupPostProcessing(): void {
    // Get container dimensions for resolution uniforms (fallback to window if container not ready)
    const containerRect = this._targetElement?.getBoundingClientRect();
    const width = containerRect?.width || window.innerWidth;
    const height = containerRect?.height || window.innerHeight;

    // Implementation identical to JS version
    this.composer = new EffectComposer(this.renderer);
    if ("multisampling" in this.composer) {
      (this.composer as any).multisampling = 0;
    }

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // Create terminal effect shader
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

    // Create sharpening effect shader
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

    // Create color adjustment effect shader
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

    // Final output pass for modern EffectComposer pipeline
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  // ============================================================================
  // STATE & ANIMATION METHODS
  // ============================================================================

  public setState(newState: StarfieldState): void {
    // Start a smooth transition between idle and shake
    const nowMs = performance.now();
    this._shakeTransitionStartMs = nowMs;
    this._shakeTransitionFrom =
      this._currentShakeBlend || (this.state === "shake" ? 1 : 0);
    this._shakeTransitionTo = newState === "shake" ? 1 : 0;

    // Reset state-specific variables
    if (this.state === "warping" && newState !== "warping") {
      // Only trigger cancel callback if warp wasn't completed successfully
      if (
        !this._warpCompleted &&
        this.callbacks.onWarpCancel &&
        typeof this.callbacks.onWarpCancel === "function"
      ) {
        this.callbacks.onWarpCancel();
      }

      this.warpTime = 0;
      this.warpPhase = "IDLE";
      this.warpProgress = 0;
      this.warpOverlay.deactivate();
      this._warpCompleted = false;
    }

    if (newState === "warping") {
      // Always deselect current game object before warping
      if (this.gameObjectManager) {
        const selectedObject = this.gameObjectManager.getSelectedObject();
        if (selectedObject) {
          this.gameObjectManager.deselectObject(selectedObject.id);
        }
      }

      this.clearLookAtTarget();

      // Reset warp timing to ensure consistent animation
      this.warpTime = 0;
      this.warpElapsedSec = 0;
      this.warpPhase = "CHARGING";
      this.warpOverlay.activate();

      // Store the start time for relative warp timing
      this._warpStartTime = this.clock.getElapsedTime();

      // Trigger the onWarpStart callback if provided
      if (
        this.callbacks.onWarpStart &&
        typeof this.callbacks.onWarpStart === "function"
      ) {
        this.callbacks.onWarpStart();
      }
    }

    // Capture current rotation as the base for shake to avoid snapping to 0
    if (newState === "shake") {
      this._preShakeRotation = {
        x: this.camera.rotation.x,
        y: this.camera.rotation.y,
        z: this.camera.rotation.z,
      };
      // Start clouds shake transition from 0
      this._cloudsShakeStartTime = this.clock.getElapsedTime();
    }

    console.debug(`State transition: ${this.state} -> ${newState}`);
    this.state = newState;

    // Reset shake intensity when transitioning to idle
    if (newState === "idle") {
      this.currentShakeIntensity = 0;
    }

    // Inform star layer manager of state change
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
        (this.cameraLookAtAnimator as any).active) ||
      this.cameraLookAtLock
    ) {
      return;
    }

    // Use Clock's elapsed time for shake animation
    const shakeTime =
      this.clock.getElapsedTime() * this._cachedConfig.shakeSpeed;

    // Camera shake (position)
    this.camera.position.x =
      Math.sin(shakeTime * 50) * this._cachedConfig.shakeIntensity * 0.1;
    this.camera.position.y =
      Math.cos(shakeTime * 47) * this._cachedConfig.shakeIntensity * 0.1;

    // Move stars forward and recycle when passing camera (all layers)
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

    // Avoid double-applying with shader offset
    this.starLayerManager!.batchUpdateUniforms({ forwardOffset: 0 });

    // Add rotation shake around the pre-shake baseline to avoid snapping
    const baseRot = this._preShakeRotation || { x: 0, y: 0, z: 0 };
    this.camera.rotation.x = baseRot.x; // keep X from idle baseline
    this.camera.rotation.y = baseRot.y; // keep Y from idle baseline
    this.camera.rotation.z =
      baseRot.z +
      Math.sin(shakeTime * 30) * this._cachedConfig.shakeIntensity * 0.01;
  }

  private updateWarpAnimation(dtSeconds: number): void {
    // During warp, we ignore look-at lock (warp owns camera), so no early return here
    // Calculate elapsed time since warp started
    if (!this._warpStartTime) {
      this._warpStartTime = this.clock.getElapsedTime();
    }
    this.warpElapsedSec = this.clock.getElapsedTime() - this._warpStartTime;

    // Use seconds-based duration
    const totalDuration = this.config.warpDurationSec || 10;

    // Define phase timings scaled to totalDuration
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

    // Determine current phase
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

    if (this.warpElapsedSec >= totalDuration) {
      // Reset warp-related uniforms and camera to defaults (all layers)
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

      // Restore camera FOV and use camera manager to return to origin smoothly
      this.camera.fov = 60;
      this.camera.updateProjectionMatrix();

      this.clearLookAtTarget();

      // Clear phase text
      this._updatePhaseText && this._updatePhaseText("");

      // Ensure star positions are fully reset to originals (all layers)
      this.starLayerManager!.updateStarPositions(
        (positions, original, _layer) => {
          for (let i = 0; i < positions.length; i++) {
            positions[i] = original[i];
          }
        }
      );

      // Reset nebula warp uniforms
      this._nebula?.reset();

      // Hard stop overlay visuals
      if (this.warpOverlay) {
        this.warpOverlay.intensity = 0;
        this.warpOverlay.trails = [];
        if (this.warpOverlay.ctx && this.warpOverlay.canvas) {
          this.warpOverlay.ctx.clearRect(
            0,
            0,
            this.warpOverlay.canvas.width,
            this.warpOverlay.canvas.height
          );
        }
      }

      // Set flag to indicate warp completed successfully
      this._warpCompleted = true;

      // Trigger the onWarpComplete callback if provided
      if (
        this.callbacks.onWarpComplete &&
        typeof this.callbacks.onWarpComplete === "function"
      ) {
        this.callbacks.onWarpComplete();
      }

      // Reset all warp-related state variables
      this.warpTime = 0;
      this.warpElapsedSec = 0;
      this.warpPhase = "IDLE";
      this.warpProgress = 0;
      this.tunnelEffectValue = 0;
      this.shakeIntensityMultiplier = 0;
      this.currentShakeIntensity = 0;
      this._warpStartTime = undefined;

      // Reset white flash
      if (this.whiteFlash) {
        this.whiteFlash.style.opacity = "0";
      }

      // Back to idle
      this.setState("idle");
      return;
    }

    // Check if we're transitioning to FLASH phase and need to create new scene
    if (currentPhase === "FLASH" && this.warpPhase !== "FLASH") {
      console.debug("Transitioning to FLASH phase - creating new scene");
      this._createNewScene();
    }

    this.warpPhase = currentPhase;
    // Use pre-created string to avoid concatenation garbage
    if (this._updatePhaseText) {
      this._updatePhaseText(
        this._phasePrefix +
          currentPhase +
          " (" +
          Math.floor(phaseProgress * 100) +
          "%)"
      );
    }

    // Update effects based on phase
    switch (currentPhase) {
      case "CHARGING":
        // Soft shaking that builds
        this.shakeIntensityMultiplier = phaseProgress * 0.5;
        this.warpProgress = phaseProgress * 0.1;
        this.tunnelEffectValue = phaseProgress * 0.2;
        break;

      case "BUILDUP":
        // Intensity grows significantly
        this.shakeIntensityMultiplier = 0.5 + phaseProgress * 1.0;
        this.warpProgress = 0.1 + phaseProgress * 0.4;
        this.tunnelEffectValue = 0.2 + phaseProgress * 0.5;
        break;

      case "CLIMAX":
        // Maximum intensity with strong shake
        this.shakeIntensityMultiplier = 1.2;
        this.warpProgress = 0.5 + phaseProgress * 0.5;
        this.tunnelEffectValue = 0.7 + phaseProgress * 0.3;
        // Add subtle camera zoom during climax
        this.camera.position.z = -10 - phaseProgress * 5;
        break;

      case "FLASH":
        // Extended white flash with intense shake
        if (this.whiteFlash) {
          // Make the flash more dramatic - start bright and fade out slowly
          const flashIntensity = Math.max(0, 1 - phaseProgress * 1.5);
          this.whiteFlash.style.opacity = flashIntensity.toString();
        }
        this.shakeIntensityMultiplier = 2.5 * (1 - phaseProgress);
        this.warpProgress = 1.0;
        this.tunnelEffectValue = 1.0;
        break;

      case "COOLDOWN":
        if (this.whiteFlash) {
          const fadeOutIntensity = Math.max(0, 0.3 * (1 - phaseProgress));
          this.whiteFlash.style.opacity = fadeOutIntensity.toString();
        }
        this.shakeIntensityMultiplier = (1 - phaseProgress) * 1.0;
        this.warpProgress = 1 - phaseProgress;
        this.tunnelEffectValue = (1 - phaseProgress) * 0.5;
        break;
    }

    // Apply shake using Clock's elapsed time
    const shakeTime =
      this.clock.getElapsedTime() * this._cachedConfig.shakeSpeed;
    const shakeAmount =
      this._cachedConfig.shakeIntensity * this.shakeIntensityMultiplier;
    this.camera.position.x = Math.sin(shakeTime * 50) * shakeAmount * 0.1;
    this.camera.position.y = Math.cos(shakeTime * 47) * shakeAmount * 0.1;
    this.camera.rotation.z = Math.sin(shakeTime * 30) * shakeAmount * 0.01;

    // Update current shake intensity for warp state
    this.currentShakeIntensity = shakeAmount;

    // Update shader uniforms for all star layers
    this.starLayerManager!.batchUpdateUniforms({
      warpProgress: this.warpProgress,
      shakeIntensity: shakeAmount,
      tunnelEffect: this.tunnelEffectValue,
    });

    // Move stars towards camera for warp effect (all layers) - CRITICAL FIX
    this.starLayerManager!.updateStarPositions((positions, original, layer) => {
      const layerConfig = layer.config;
      for (let i = 0; i < positions.length; i += 3) {
        const originalZ = original[i + 2];
        positions[i + 2] = originalZ + this.warpProgress * 30 * 30;

        // Recycle stars that pass the camera
        if (positions[i + 2] > 10) {
          positions[i + 2] = originalZ - layerConfig.maxDistance;
        }
      }
    });

    // FOV change for sucking effect using cached config
    const baseFOV = 60;
    const targetFOV = this._cachedConfig.warpFOVMax;
    this.camera.fov =
      baseFOV + (targetFOV - baseFOV) * Math.pow(this.warpProgress, 0.5);
    this.camera.updateProjectionMatrix();

    // Camera pull-back for dramatic effect
    this.camera.position.z = -this.warpProgress * 10;

    // No forward drift during warp

    // Update warp overlay
    this.warpOverlay.update(currentPhase, phaseProgress, dtSeconds || 0);

    // Keep star layer manager in sync with warp phase
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

    // Check if WebGL context is lost
    if (this.renderer.getContext().isContextLost()) {
      console.debug("WebGL context lost during animation");
      return;
    }

    this.animationId = requestAnimationFrame(() => this.animate());

    // Only run performance monitoring in debug mode
    if (this.debugMode && this.performanceMonitor) {
      this.performanceMonitor.begin();
    }

    // Time management using Three.js Clock
    const deltaSeconds = this.clock.getDelta();
    this.frameCount++;

    // Terminal pass enabled state
    if (this.terminalPass) {
      this.terminalPass.enabled = !!this.config.terminalEnabled;
    }

    // Single batch update for ALL uniforms
    this.updateFrameUniforms(deltaSeconds);

    // Handle shake blend transition
    {
      const target = this.state === "shake" ? 1 : 0;
      const tMs = this._shakeTransitionStartMs || 0;
      const duration = Math.max(
        0.001,
        (this.config.shakeTransitionTimeSec || 0.5) * 1000
      );
      const elapsed = Math.max(0, performance.now() - tMs);
      let blend = target;
      if (this._shakeTransitionTo !== undefined) {
        const from = this._shakeTransitionFrom || 0;
        const to = this._shakeTransitionTo || 0;
        const k = Math.min(1, elapsed / duration);
        const eased =
          k < 0.5 ? 4.0 * k * k * k : 1.0 - Math.pow(-2.0 * k + 2.0, 3.0) / 2.0;
        blend = from + (to - from) * eased;
      }
      this._currentShakeBlend = blend;
      // Use cached config value for performance
      const baseShake = this._cachedConfig.shakeIntensity;
      if (this.state !== "warping") {
        this.currentShakeIntensity = baseShake * blend;
      }
    }

    // Reset warp when not warping
    if (this.state !== "warping") {
      if (this.warpProgress > 0) {
        this.warpProgress -= 0.02 * deltaSeconds;
        this.warpProgress = Math.max(0, this.warpProgress);
        this.tunnelEffectValue *= Math.pow(0.95, deltaSeconds);
        this.warpOverlay.update(
          "COOLDOWN",
          1 - this.warpProgress,
          deltaSeconds
        );

        // Reset FOV and camera position using cached config
        const baseFOV = 60;
        const targetFOV = this._cachedConfig.warpFOVMax;
        this.camera.fov =
          baseFOV + (targetFOV - baseFOV) * Math.pow(this.warpProgress, 0.5);
        this.camera.updateProjectionMatrix();
        this.camera.position.z = -this.warpProgress * 10;

        // Reset star positions (all layers)
        if (this.warpProgress === 0) {
          this.starLayerManager!.updateStarPositions(
            (positions, original, _layer) => {
              for (let i = 0; i < positions.length; i++) {
                positions[i] = original[i];
              }
            }
          );
          this._updatePhaseText && this._updatePhaseText("");
        }
      }
      // When not warping, accumulate forward offset based on state using cached config
      if (this.state === "idle") {
        this.currentForwardOffset =
          (this.currentForwardOffset || 0) +
          this._cachedConfig.forwardDriftIdle * deltaSeconds;
      } else if (this.state === "shake") {
        this.currentForwardOffset =
          (this.currentForwardOffset || 0) +
          this._cachedConfig.forwardDriftShake * deltaSeconds;
      }
    }

    // Update state-specific animations
    this.updateStateAnimation(deltaSeconds);

    // Update camera animation (for game object look-at)
    this.updateCameraAnimation(deltaSeconds);

    // Update skybox-style planet position
    this.updatePlanetPosition();

    if (
      !this.renderer.getContext().isContextLost() &&
      this.config.renderingEnabled
    ) {
      this.composer.render();

      // Only capture performance stats when in debug mode
      if (this.debugMode) {
        this.perfStats.frameTime = deltaSeconds * 1000; // Convert to milliseconds

        // Capture renderer stats AFTER composer render but BEFORE resetting
        this.perfStats.drawCalls = this.renderer.info.render.calls;
        this.perfStats.triangles = this.renderer.info.render.triangles;
        this.perfStats.programs = this.renderer.info.programs
          ? this.renderer.info.programs.length
          : 0;
        this.perfStats.geometries = this.renderer.info.memory.geometries;
        this.perfStats.textures = this.renderer.info.memory.textures;
      }

      // Reset renderer info (always needed for proper rendering)
      this.renderer.info.reset();
    }

    // Only run performance monitoring in debug mode
    if (this.debugMode && this.performanceMonitor) {
      this.performanceMonitor.end();
      this.performanceMonitor.update(
        this.perfStats.frameTime,
        this.perfStats.drawCalls,
        this.perfStats.triangles,
        this.perfStats.programs,
        this.perfStats.geometries,
        this.perfStats.textures
      );
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
    // Prevent config updates when not in debug mode (except during initial load)
    if (!this.debugMode && this._initialLoadComplete) {
      console.warn(
        "Config updates disabled in production mode. Enable debug mode to modify settings."
      );
      return;
    }

    // Deep merge config to preserve nested structures
    this.config = customDeepmerge(
      this.config,
      newConfig
    ) as GalaxyStarfieldConfig;

    // Apply ALL uniform updates through the mapper
    this.configMapper.applyAllUpdates(newConfig, this.config);

    // Handle material properties (blending modes)
    //this.handleMaterialProperties(newConfig);

    // Handle shadow settings updates
    this.handleShadowSettings(newConfig);

    // Handle feature toggles (enable/disable)
    this.handleFeatureToggles(newConfig);

    // Handle starfield updates
    if (this.starLayerManager) {
      this.starLayerManager.updateConfig(newConfig);

      // Store reference to original positions for animation effects
      const firstLayer = this.starLayerManager.getFirstLayer();
      if (firstLayer) {
        this.originalPositions = firstLayer.originalPositions;
      }
    }

    // Handle game object updates
    if (this.gameObjectManager) {
      this.gameObjectManager.updateConfig(newConfig);
    }

    // Update layer manager
    if (this.layerManager) {
      this.layerManager.updateConfig(newConfig);
    }

    // Update fog if needed
    //if ("fogDensity" in newConfig) {
    //  (this.scene.fog as THREE.FogExp2).density = this.config.fogDensity;
    //}

    // Update cached config
    this.updateCachedConfig();
  }

  /**
   * TODO: Investigate what this actually does
  private handleMaterialProperties(
    newConfig: Partial<GalaxyStarfieldConfig>
  ): void {
    if (newConfig.planetBlendMode && this._background) {
      const bgMaterial = this._background.getBackgroundMaterial();
      if (bgMaterial) {
        bgMaterial.blending = this.config.planetBlendMode;
      }
    }
  }
   */

  private handleShadowSettings(
    newConfig: Partial<GalaxyStarfieldConfig>
  ): void {
    // Check if any shadow-related config changed
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
    console.debug("startWarp called - current state:", this.state);
    console.debug("warpTime:", this.warpTime, "warpPhase:", this.warpPhase);

    // Force reset any lingering warp state
    if (this.state === "warping") {
      console.debug("Forcing reset of lingering warp state");
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
  public warpToSector(
    options: WarpOptions,
    bypassAnimation: boolean = false
  ): boolean {
    if (!this.sceneManager) {
      console.warn("SceneManager not available");
      return false;
    }

    const { id, gameObjects = [], config = {} } = options;
    if (!id) {
      console.warn("Sector ID is required");
      return false;
    }

    // Check if we're already in the requested scene
    if (this._currentSceneId === id) {
      console.debug(`Already in sector ${id}, no warp needed`);
      return true;
    }

    // Check if we already have a scene with this ID
    if (this.sceneManager.hasNamedConfig(id)) {
      // Load existing sector config
      console.debug(`Loading existing sector config for: ${id}`);
      const sectorConfig = this.sceneManager.getNamedConfig(id);
      this._pendingSectorConfig = { ...sectorConfig, ...config };
      console.debug(`Loaded sector config:`, this._pendingSectorConfig);
    } else {
      // Create new sector config and store it
      console.debug(`Creating new sector config for: ${id}`);
      // Generate complete game object configs from base configs
      if (this.gameObjectManager && gameObjects.length > 0) {
        const completeGameObjects = gameObjects.map((baseConfig) => {
          return this.gameObjectManager!.generateGameObjectConfig(baseConfig);
        });

        config.gameObjects = [
          ...(config.gameObjects || []),
          ...completeGameObjects,
        ];
      }
      const sectorConfig = this.sceneManager.storeNamedConfig(id, config, true);
      this._pendingSectorConfig = sectorConfig;
      console.debug(`Created sector config:`, this._pendingSectorConfig);
    }

    this.clearGameObjectSelection();

    // Start the warp animation
    if (!this._currentSceneId || bypassAnimation) {
      this.reloadConfig(this._pendingSectorConfig);
    } else {
      this.startWarp();
    }

    // Update current scene ID
    this._currentSceneId = id;

    // Start rendering after scene is ready
    this.startRendering();
    return true;
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
  public getSector(sectorId: string): any | null {
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
    console.debug(`Current scene ID set to: ${sceneId}`);
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

  // ============================================================================
  // GAME OBJECT API METHODS
  // ============================================================================

  /**
   * Select a game object by ID
   */
  public selectGameObject(
    objectId: string,
    options: SelectionOptions = {}
  ): boolean {
    if (this.gameObjectManager) {
      const success = this.gameObjectManager.selectObject(objectId);

      // If selection was successful and we have a valid object ID, look at it
      if (success && objectId) {
        // Start dimming all layers when object is selected
        if (this.layerManager) {
          this.layerManager.startDimming();
          console.debug("Starfield: Started layer dimming for selected object");
        }

        // Trigger the onGameObjectSelected callback if provided
        if (
          this.callbacks.onGameObjectSelected &&
          typeof this.callbacks.onGameObjectSelected === "function"
        ) {
          const gameObject = this.gameObjectManager.getObject(objectId);
          if (gameObject) {
            this.callbacks.onGameObjectSelected(gameObject);
          }
        }

        // Merge default config options with provided options
        const defaultOptions = {
          zoomFactor: this.config.cameraZoomFactor,
          ...options,
        };

        this.lookAtGameObject(objectId, defaultOptions);
      }

      return success;
    }
    return false;
  }

  /**
   * Clear the currently selected game object
   */
  public clearGameObjectSelection(): boolean {
    if (this.gameObjectManager) {
      const selectedObject = this.gameObjectManager.getSelectedObject();
      if (selectedObject) {
        this.gameObjectManager.deselectObject(selectedObject.id);

        // Restore all layers to full intensity when object is deselected
        if (this.layerManager) {
          this.layerManager.startRestoration();
          console.debug(
            "Starfield: Started layer restoration for deselected object"
          );
        }

        // Clear the look-at target to return to origin
        this.clearLookAtTarget();

        // Trigger the onGameObjectCleared callback if provided
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
   * Look at a specific game object with smooth animation
   */
  public lookAtGameObject(
    objectId: string,
    options: LookAtOptions = {}
  ): boolean {
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
      this.cameraLookAtAnimator.lookAtGameObject(gameObject.mesh, {
        ...options,
        onComplete: () => {
          this.cameraLookAtLock = null;

          if (
            this.callbacks.onGameObjectInView &&
            typeof this.callbacks.onGameObjectInView === "function"
          ) {
            this.callbacks.onGameObjectInView(gameObject);
          }
        },
      });

      this.cameraLookAtLock = { mesh: gameObject.mesh };
    }

    return true;
  }

  /**
   * Clear the look-at target, returning to origin
   */
  private clearLookAtTarget(): void {
    if (this.cameraLookAtAnimator) {
      // Use unified camera system to return to origin
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
    this._cachedConfig.forwardDriftIdle = this.config.forwardDriftIdle || 0;
    this._cachedConfig.forwardDriftShake = this.config.forwardDriftShake || 0;
    this._cachedConfig.idleSwayRandomSpeed =
      this.config.idleSwayRandomSpeed || 0.2;
    this._cachedConfig.idleSwayRandomIntensity =
      this.config.idleSwayRandomIntensity || 0.1;
    this._cachedConfig.warpFOVMax = this.config.warpFOVMax || 60;
  }

  private updateFrameUniforms(deltaSeconds?: number): void {
    // Update global time
    this.uniformManager.updateGlobalTimeUniforms(this.clock.getElapsedTime());

    // Update reusable frameState object (no allocation)
    this._frameState.currentState = this.state;
    this._frameState.currentShakeIntensity = this.currentShakeIntensity || 0;
    this._frameState.shakePhase = this.clock.getElapsedTime();
    this._frameState.cloudsShakeProgress = this.getCloudsShakeProgress(); // Critical fix
    this._frameState.warpProgress = this.warpProgress || 0;
    this._frameState.tunnelEffectValue = this.tunnelEffectValue || 0;
    this._frameState.cameraRotation.x = this.camera.rotation.x;
    this._frameState.cameraRotation.y = this.camera.rotation.y;
    this._frameState.cameraRotation.z = this.camera.rotation.z;

    // Get dimming factors from layer manager if available
    const dimmingFactors = this.layerManager?.getDimmingFactors();

    const updates = this.configMapper.getFrameUpdates(
      this._frameState,
      this.config,
      dimmingFactors
    );

    // Batch all uniform updates for performance
    this.batchUniformUpdates(updates);

    // Update shadow center if needed
    if (this.shadowManager?.shouldUpdateShadowCenter()) {
      this.shadowManager.updateShadowCenter(this.camera);
    }

    // Check if planet group is now available and set it in ShadowManager
    if (this.shadowManager && this._background?.getPlanetGroup()) {
      const currentPlanetGroup = this.shadowManager.getPlanetGroup();
      const newPlanetGroup = this._background.getPlanetGroup()!;

      // Check if planet group reference has changed (scene recreation)
      if (!currentPlanetGroup || currentPlanetGroup !== newPlanetGroup) {
        console.debug(
          "[Starfield] Planet group changed or new, updating ShadowManager"
        );
        this.shadowManager.setPlanetGroup(
          newPlanetGroup,
          this._background.getPlanetRandomOffset()!
        );

        // Now apply initial shadow settings since materials should be ready
        this.shadowManager.applyInitialSettings();
      }
    }
  }

  private batchUniformUpdates(configUpdates: any): void {
    // Prepare star layer uniforms with change detection
    const starLayerUniforms = {
      shakeIntensity: this.currentShakeIntensity || 0,
      warpProgress: this.warpProgress || 0,
      tunnelEffect: this.tunnelEffectValue || 0,
      forwardOffset: this.currentForwardOffset || 0,
    };

    // Check for changes to avoid redundant updates
    let starLayerUniformsChanged = false;
    Object.entries(starLayerUniforms).forEach(([key, value]) => {
      if ((this._cachedUniforms as any)[key] !== value) {
        (this._cachedUniforms as any)[key] = value;
        starLayerUniformsChanged = true;
      }
    });

    // Apply config mapper updates
    Object.entries(configUpdates).forEach(([materialId, uniforms]) => {
      if (uniforms && this.uniformManager.hasMaterial(materialId)) {
        this.uniformManager.updateUniforms(materialId, uniforms);
      }
    });

    // Apply star layer updates only if changed
    if (starLayerUniformsChanged) {
      this.starLayerManager!.batchUpdateUniforms(starLayerUniforms);
    }

    // Update game object rotations only (positions remain fixed)
    if (this.gameObjectManager) {
      this.gameObjectManager.updateRotations();
    }

    // Update layer manager animations
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
  public reloadConfig(
    newConfig: Partial<GalaxyStarfieldConfig> | null = null
  ): void {
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
    if (this.config.planetEnabled) {
      this._background?.create(this.config);
      this.shadowManager?.onSceneChange();
    }

    if (this.config.nebulaEnabled) {
      this._nebula?.create(this.config);
    }

    if (this.config.cloudsEnabled) {
      this._clouds?.create(this.config);
    }

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
   * Create a new scene using the SceneManager
   * @private
   */
  private _createNewScene(): void {
    if (!this.sceneManager) {
      console.warn("SceneManager not available");
      return;
    }

    let newConfig;

    // Check if we have a pending sector config to use
    if (this._pendingSectorConfig) {
      newConfig = this._pendingSectorConfig;
      console.debug("Using pending sector config for new scene:", newConfig);
      this._pendingSectorConfig = null;
    } else {
      newConfig = this.sceneManager.create(this.config);
      console.debug("Creating random scene configuration");
    }

    // For random scenes, we don't have a specific scene ID, so set to null
    this.reloadConfig(newConfig, null);
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
    console.debug("Starfield rendering started");

    // Start the animation loop
    this.animate();

    // Trigger callback if provided
    if (
      this.callbacks.onSceneReady &&
      typeof this.callbacks.onSceneReady === "function"
    ) {
      this.callbacks.onSceneReady();
    }
  }

  /**
   * Stop rendering the scene
   */
  public stopRendering(): void {
    this._isRendering = false;
    console.debug("Starfield rendering stopped");
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
  public initializeScene(): void {
    // Generate initial scene if needed
    if (!this.config.gameObjects || this.config.gameObjects.length === 0) {
      this.config = this.sceneManager!.create(this.config);
    }

    // Start rendering
    this.startRendering();
  }
}
