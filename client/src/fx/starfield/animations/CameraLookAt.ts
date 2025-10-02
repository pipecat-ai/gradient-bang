import CameraControls from "camera-controls";
import * as THREE from "three";
import { type GalaxyStarfieldConfig } from "../constants";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Animation completion callback function */
export type AnimationCallback = () => void;

/** Camera look-at animation options */
export interface LookAtOptions {
  zoomFactor?: number;
  onComplete?: AnimationCallback;
}

/** Camera sway configuration */
export interface SwayConfig {
  enabled?: boolean;
  intensity?: number;
  speed?: number;
}

/** Camera target object */
export interface CameraTarget {
  position: THREE.Vector3;
  name: string;
}

/** Camera animation states */
export interface CameraAnimationStates {
  active: boolean;
  pendingCallbacks: number;
  currentTarget: CameraTarget | null;
  defaultOriginTarget: THREE.Vector3;
  cameraPosition: THREE.Vector3;
  cameraRotation: THREE.Euler;
  swayEnabled: boolean;
  swayTime: number;
  swayOffset: THREE.Vector3;
}

// ============================================================================
// CAMERA LOOK-AT ANIMATOR CLASS
// ============================================================================

/**
 * Camera Controller using camera-controls library
 * Provides smooth look-at and movement to specified distance
 */
export class CameraLookAtAnimator {
  private camera: THREE.PerspectiveCamera;
  private config: GalaxyStarfieldConfig;
  private cameraControls: CameraControls;
  private swayTime: number;
  private swayOffset: THREE.Vector3;
  private currentTarget: CameraTarget | null;
  private defaultOriginTarget: THREE.Vector3;
  private pendingCallbacks: Map<number, AnimationCallback>;

  constructor(
    camera: THREE.PerspectiveCamera,
    config: GalaxyStarfieldConfig,
    domElement: HTMLElement | undefined = undefined
  ) {
    this.camera = camera;
    this.config = config;

    // Install camera-controls for Three.js
    CameraControls.install({ THREE: THREE });

    this.cameraControls = new CameraControls(
      camera,
      config.debugMode ? domElement : undefined
    );

    // Initialize sway animation state
    this.swayTime = 0;
    this.swayOffset = new THREE.Vector3();

    // Configure camera controls for smooth movement
    this.cameraControls.smoothTime = 1;
    this.cameraControls.azimuthRotateSpeed = 1;
    this.cameraControls.polarRotateSpeed = 11;
    this.cameraControls.dollySpeed = 0.5;
    this.cameraControls.truckSpeed = 0.5;

    // Set rest threshold to account for sway animation
    // This should be higher than the sway movement to avoid false triggers
    this.cameraControls.restThreshold = 2;

    // Current target state
    this.currentTarget = null;

    // Set default origin target (looking forward from origin)
    this.defaultOriginTarget = new THREE.Vector3(0, 0, -100);

    // Set initial camera orientation - look forward (negative Z direction)
    // This ensures consistent starting orientation for animations
    void this.cameraControls.setLookAt(
      camera.position.x,
      camera.position.y,
      camera.position.z,
      camera.position.x,
      camera.position.y,
      camera.position.z - 100,
      false
    );

    // Track pending callbacks
    this.pendingCallbacks = new Map();

    // Listen for camera-controls events to handle onComplete callbacks
    this.cameraControls.addEventListener(
      "transitionstart",
      this.handleTransitionStart.bind(this)
    );
    this.cameraControls.addEventListener("rest", this.handleRest.bind(this));
    this.cameraControls.addEventListener("sleep", this.handleSleep.bind(this));
  }

  /**
   * Handle transition start event
   */
  private handleTransitionStart(): void {
    // Transition has started, we can track this if needed
  }

  /**
   * Handle rest event - camera has slowed down significantly
   */
  private handleRest(): void {
    // Camera has slowed down significantly, trigger onComplete callbacks
    if (this.pendingCallbacks.size > 0) {
      for (const [, callback] of this.pendingCallbacks) {
        try {
          callback();
        } catch (error) {
          console.warn("Error in camera animation callback:", error);
        }
      }
      this.pendingCallbacks.clear();
    }
  }

  /**
   * Handle sleep event - camera has completely stopped
   */
  private handleSleep(): void {
    // Camera has completely stopped, trigger onComplete callbacks
    for (const [id, callback] of this.pendingCallbacks) {
      callback();
      this.pendingCallbacks.delete(id);
    }
  }

  /**
   * Look at a game object with smooth rotation and movement to specified distance
   * @param {THREE.Object3D} objectMesh - Game object mesh
   * @param {Object} options - Animation options
   */
  public lookAtGameObject(
    objectMesh: THREE.Object3D,
    options: LookAtOptions = {}
  ): boolean {
    if (!objectMesh || !objectMesh.position) {
      return false;
    }

    const { zoomFactor = this.config.cameraZoomFactor, onComplete = null } =
      options;

    // Reset sway offset when starting new camera movement
    this.resetSwayOffset();

    // Clear any pending callbacks from previous animations
    this.pendingCallbacks.clear();

    // Create target object from mesh
    const target: CameraTarget = {
      position: objectMesh.position,
      name:
        (objectMesh.userData?.name as string) ||
        objectMesh.name ||
        "game_object",
    };

    // Calculate target distance using constants
    const targetDistance = 100 * (zoomFactor || 1.0);

    // Calculate direction from target to current camera position
    const direction = new THREE.Vector3()
      .subVectors(this.camera.position, objectMesh.position)
      .normalize();

    // Calculate new camera position at the target distance
    const newCameraPosition = objectMesh.position
      .clone()
      .add(direction.multiplyScalar(targetDistance));

    // Use camera-controls setLookAt to move camera AND look at target in one smooth operation
    void this.cameraControls
      .normalizeRotations()
      .setLookAt(
        newCameraPosition.x,
        newCameraPosition.y,
        newCameraPosition.z,
        objectMesh.position.x,
        objectMesh.position.y,
        objectMesh.position.z,
        true
      );

    // Update current target
    this.currentTarget = target;

    // Store callback if provided
    if (onComplete) {
      const callbackId = Date.now() + Math.random();
      this.pendingCallbacks.set(callbackId, onComplete);
      console.debug(
        "CameraLookAt: Callback stored, pending callbacks:",
        this.pendingCallbacks.size
      );
    }

    return true;
  }

  /**
   * Return to origin position
   * @param {Object} originTarget - Optional target to look at when returning to origin
   */
  public returnToOrigin(originTarget: THREE.Vector3): void {
    console.debug("returnToOrigin called - moving camera to origin");

    // Reset sway offset when starting new camera movement
    this.resetSwayOffset();

    // Clear any pending callbacks from previous animations
    this.pendingCallbacks.clear();

    let targetPosition: THREE.Vector3;
    if (originTarget) {
      targetPosition = originTarget;
    } else {
      targetPosition = this.defaultOriginTarget;
    }

    // Move camera back to origin position (0, 0, 0)
    // and look at the target for a nice default view
    void this.cameraControls.normalizeRotations().setLookAt(
      0,
      0,
      0, // Camera position at origin
      targetPosition.x,
      targetPosition.y,
      targetPosition.z, // Look at the target
      true
    );

    // Clear current target since we're back at origin
    this.currentTarget = null;
  }

  /**
   * Update the camera system
   * @param {number} deltaSeconds - Time delta in seconds
   * @returns {boolean} True if camera controls updated (needs re-render)
   */
  public update(deltaSeconds: number): boolean {
    // Update camera controls
    const controlsUpdated = this.cameraControls.update(deltaSeconds);

    // Update sway animation if enabled
    if (this.config.cameraSwayEnabled) {
      this.updateSway(deltaSeconds);
    }

    return controlsUpdated;
  }

  /**
   * Update camera sway animation
   * @param {number} deltaSeconds - Time delta in seconds
   */
  private updateSway(deltaSeconds: number): void {
    // Always update sway time for continuous motion
    this.swayTime += deltaSeconds * this.config.cameraSwaySpeed;

    // Generate smooth random sway using multiple sine waves with different frequencies
    // This creates a more organic, spaceship-like movement
    const swayX =
      Math.sin(this.swayTime * 0.7) * 0.4 +
      Math.sin(this.swayTime * 1.3) * 0.3 +
      Math.sin(this.swayTime * 2.1) * 0.2 +
      Math.sin(this.swayTime * 0.3) * 0.1;

    const swayY =
      Math.sin(this.swayTime * 0.9) * 0.4 +
      Math.sin(this.swayTime * 1.7) * 0.3 +
      Math.sin(this.swayTime * 2.5) * 0.2 +
      Math.sin(this.swayTime * 0.5) * 0.1;

    const swayZ =
      Math.sin(this.swayTime * 0.5) * 0.3 +
      Math.sin(this.swayTime * 1.1) * 0.2 +
      Math.sin(this.swayTime * 1.9) * 0.1;

    // Apply sway intensity and convert to world units
    this.swayOffset.set(
      swayX * this.config.cameraSwayIntensity,
      swayY * this.config.cameraSwayIntensity,
      swayZ * this.config.cameraSwayIntensity
    );

    // Apply sway offset to camera position
    this.camera.position.add(this.swayOffset);

    // Apply subtle rotation for more realistic spaceship feel
    // Use smaller rotation values to avoid disorienting the user
    const rotationIntensity = this.config.cameraSwayIntensity * 0.005;
    this.camera.rotation.x += swayY * rotationIntensity;
    this.camera.rotation.y += swayX * rotationIntensity;
    this.camera.rotation.z += swayZ * rotationIntensity * 0.3;
  }

  /**
   * Reset sway offset to prevent accumulation during camera movements
   */
  private resetSwayOffset(): void {
    // Remove any accumulated sway offset
    if (this.swayOffset.length() > 0.001) {
      this.camera.position.sub(this.swayOffset);
      this.swayOffset.set(0, 0, 0);
    }
  }

  /**
   * Get current sway configuration
   * @returns {Object} Sway configuration object
   */
  public getSwayConfig(): SwayConfig {
    return {
      enabled: this.config.cameraSwayEnabled,
      intensity: this.config.cameraSwayIntensity,
      speed: this.config.cameraSwaySpeed,
    };
  }

  /**
   * Update sway configuration
   * @param {Object} config - New sway configuration
   */
  public updateSwayConfig(config: SwayConfig): void {
    const oldConfig = this.getSwayConfig();

    if (config.enabled !== undefined) {
      this.config.cameraSwayEnabled = config.enabled;
    }
    if (config.intensity !== undefined) {
      this.config.cameraSwayIntensity = Math.max(
        0,
        Math.min(2, config.intensity)
      );
    }
    if (config.speed !== undefined) {
      this.config.cameraSwaySpeed = Math.max(0.1, Math.min(10, config.speed));
    }

    // Log configuration changes for debugging
    const newConfig = this.getSwayConfig();
    if (JSON.stringify(oldConfig) !== JSON.stringify(newConfig)) {
      console.debug("Camera sway config updated:", newConfig);
    }
  }

  /**
   * Clear all pending animations
   */
  public clearPendingAnimations(): void {
    this.pendingCallbacks.clear();
  }

  /**
   * Check if any animation is active
   */
  public get active(): boolean {
    return this.cameraControls.active;
  }

  /**
   * Get current animation states for debugging
   */
  public getAnimationStates(): CameraAnimationStates {
    return {
      active: this.cameraControls.active,
      pendingCallbacks: this.pendingCallbacks.size,
      currentTarget: this.currentTarget,
      defaultOriginTarget: this.defaultOriginTarget,
      cameraPosition: this.camera.position.clone(),
      cameraRotation: this.camera.rotation.clone(),
      swayEnabled: this.config.cameraSwayEnabled,
      swayTime: this.swayTime,
      swayOffset: this.swayOffset.clone(),
    };
  }

  /**
   * Enable user camera controls (mouse/touch)
   */
  public enableUserControls(): void {
    if (this.cameraControls) {
      this.cameraControls.enabled = true;
    }
  }

  /**
   * Disable user camera controls (mouse/touch)
   */
  public disableUserControls(): void {
    if (this.cameraControls) {
      this.cameraControls.enabled = false;
    }
  }

  /**
   * Get the camera controls instance for advanced usage
   * @returns {CameraControls} The camera controls instance
   */
  public getCameraControls(): CameraControls {
    return this.cameraControls;
  }

  /**
   * Set a custom origin target for consistent return-to-origin behavior
   * @param {THREE.Vector3|Object} target - Target position or object with position
   */
  public setOriginTarget(target: THREE.Vector3): void {
    if (target instanceof THREE.Vector3) {
      this.defaultOriginTarget.copy(target);
    } else {
      console.warn("CameraLookAtAnimator: Invalid origin target provided");
    }
  }

  /**
   * Clean up camera controls when disposing
   */
  public dispose(): void {
    if (this.cameraControls) {
      this.cameraControls.removeEventListener(
        "transitionstart",
        this.handleTransitionStart.bind(this)
      );
      this.cameraControls.removeEventListener(
        "rest",
        this.handleRest.bind(this)
      );
      this.cameraControls.removeEventListener(
        "sleep",
        this.handleSleep.bind(this)
      );
      this.cameraControls.dispose();
    }
  }

  // Legacy compatibility methods - these now use camera-controls
  public setSwayEnabled(enabled: boolean): void {
    if (this.config) {
      this.config.cameraSwayEnabled = enabled;
    }
  }

  public isSwayEnabled(): boolean {
    return this.config ? this.config.cameraSwayEnabled : false;
  }
}

export default CameraLookAtAnimator;
