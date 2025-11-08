/**
 * ControlsManager - Dynamically generates and manages debug controls
 */

import type { GalaxyStarfield } from "../main";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type ControlType = "range" | "checkbox" | "button";

export interface ControlConfig {
  id: string;
  type: ControlType;
  label: string;
  path: string;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

interface ControlMetadata {
  type: ControlType;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  category: string;
}

// ============================================================================
// CONTROLS MANAGER CLASS
// ============================================================================

export class ControlsManager {
  private starfield: GalaxyStarfield;
  private controlsPanel: HTMLElement | null;
  private controlsContent: HTMLElement | null;
  private isInitialized: boolean;

  // Control registry for automatic updates
  private controlRegistry: Map<
    string,
    { element: HTMLElement; config: ControlConfig }
  > = new Map();

  constructor(starfield: GalaxyStarfield) {
    this.starfield = starfield;
    this.controlsPanel = null;
    this.controlsContent = null;
    this.isInitialized = false;

    this.init();
  }

  // ============================================================================
  // PUBLIC METHODS
  // ============================================================================

  public init(): void {
    if (this.isInitialized) return;

    // Create the controls panel if it doesn't exist
    this.controlsPanel = this.getElement("controlsPanel");
    if (!this.controlsPanel) {
      this.controlsPanel = this.createControlsPanel();
      document.body.appendChild(this.controlsPanel);
    }

    this.controlsContent = this.getElement("controlsContent");
    if (!this.controlsContent) return;

    this.setupMinimizeButton();
    this.generateBasicControls();
    this.generateDynamicControls();

    this.isInitialized = true;
  }

  public refresh(): void {
    this.refreshAllControls();
  }

  public destroy(): void {
    const basicControls = document.querySelector(".controls");
    if (basicControls && basicControls.parentNode) {
      basicControls.parentNode.removeChild(basicControls);
    }

    if (this.controlsPanel && this.controlsPanel.parentNode) {
      this.controlsPanel.parentNode.removeChild(this.controlsPanel);
    }

    this.controlsPanel = null;
    this.controlsContent = null;
    this.controlRegistry.clear();
    this.isInitialized = false;
  }

  // ============================================================================
  // PRIVATE SETUP METHODS
  // ============================================================================

  private setupMinimizeButton(): void {
    const minimizeButton = this.getElement("minimizeButton");
    if (minimizeButton) {
      minimizeButton.addEventListener("click", () => this.toggleMinimize());
    }
  }

  private setupAccordion(): void {
    const headers = document.querySelectorAll(".accordion-header");
    headers.forEach((header) => {
      header.addEventListener("click", () => {
        const targetId = header.getAttribute("data-target");
        if (!targetId) return;

        const content = document.getElementById(targetId);
        const arrow = header.querySelector(".accordion-arrow");
        if (!content || !arrow) return;

        const isActive = content.classList.contains("active");
        content.classList.toggle("active");
        arrow.textContent = isActive ? "▶" : "▼";
      });
    });
  }

  private setupEventListeners(): void {
    // Range inputs
    document.querySelectorAll('input[type="range"]').forEach((input) => {
      const valueSpan = document.getElementById(
        (input as HTMLInputElement).id + "Value"
      );
      if (valueSpan) {
        input.addEventListener("input", (e) => {
          const target = e.target as HTMLInputElement;
          valueSpan.textContent = target.value;
          this.updateConfigFromControl(target.id, parseFloat(target.value));
        });
      }
    });

    // Checkbox inputs
    document.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", (e) => {
        const target = e.target as HTMLInputElement;
        this.updateConfigFromControl(target.id, target.checked);
      });
    });
  }

  // ============================================================================
  // CONTROL GENERATION METHODS
  // ============================================================================

  private generateBasicControls(): void {
    if (!this.controlsPanel) return;

    const controlsContainer = this.createElement("div", "controls");
    const controls: ControlConfig[] = [
      {
        id: "idle",
        type: "button" as ControlType,
        label: "IDLE",
        path: "idle",
        className: "active",
      },
      {
        id: "shake",
        type: "button" as ControlType,
        label: "SHAKE",
        path: "shake",
      },
      {
        id: "warping",
        type: "button" as ControlType,
        label: "WARPING",
        path: "warping",
      },
      {
        id: "pause",
        type: "button" as ControlType,
        label: "PAUSE",
        path: "pause",
      },
      {
        id: "logConfig",
        type: "button" as ControlType,
        label: "LOG CONFIG",
        path: "logConfig",
      },
    ];

    controls.forEach((control) => {
      controlsContainer.appendChild(this.createControlItem(control));
    });

    // Insert the basic controls as a sibling element so they can float at top-left
    this.controlsPanel.parentNode?.insertBefore(
      controlsContainer,
      this.controlsPanel
    );
  }

  private generateDynamicControls(): void {
    if (!this.controlsContent) return;

    this.controlsContent.innerHTML = "";

    // Define control metadata for automatic generation
    const controlMetadata: Record<string, ControlMetadata> = {
      // Star LOD System
      "starLOD.hero.enabled": {
        type: "checkbox",
        label: "Hero Layer",
        category: "STAR LOD SYSTEM",
      },
      "starLOD.hero.count": {
        type: "range",
        label: "Hero Stars",
        min: 500,
        max: 8000,
        step: 100,
        category: "STAR LOD SYSTEM",
      },
      "starLOD.mid.enabled": {
        type: "checkbox",
        label: "Mid Layer",
        category: "STAR LOD SYSTEM",
      },
      "starLOD.mid.count": {
        type: "range",
        label: "Mid Stars",
        min: 1000,
        max: 12000,
        step: 200,
        category: "STAR LOD SYSTEM",
      },
      "starLOD.far.enabled": {
        type: "checkbox",
        label: "Far Layer",
        category: "STAR LOD SYSTEM",
      },
      "starLOD.far.count": {
        type: "range",
        label: "Far Stars",
        min: 2000,
        max: 20000,
        step: 500,
        category: "STAR LOD SYSTEM",
      },
      starSize: {
        type: "range",
        label: "Global Size",
        min: 0.2,
        max: 3.0,
        step: 0.1,
        category: "STAR LOD SYSTEM",
      },
      "starLOD.hero.baseSize": {
        type: "range",
        label: "Hero Size",
        min: 0.5,
        max: 3.0,
        step: 0.1,
        category: "STAR LOD SYSTEM",
      },
      "starLOD.mid.baseSize": {
        type: "range",
        label: "Mid Size",
        min: 0.2,
        max: 2.0,
        step: 0.1,
        category: "STAR LOD SYSTEM",
      },
      "starLOD.far.baseSize": {
        type: "range",
        label: "Far Size",
        min: 0.1,
        max: 1.0,
        step: 0.1,
        category: "STAR LOD SYSTEM",
      },
      motionBlurIntensity: {
        type: "range",
        label: "Motion Blur",
        min: 0,
        max: 2.0,
        step: 0.1,
        category: "STAR LOD SYSTEM",
      },

      // Cloud Controls
      cloudsEnabled: {
        type: "checkbox",
        label: "Enable",
        category: "CLOUD CONTROLS",
      },
      cloudsSpeed: {
        type: "range",
        label: "Speed",
        min: 0,
        max: 0.01,
        step: 0.0001,
        category: "CLOUD CONTROLS",
      },
      cloudsDomainScale: {
        type: "range",
        label: "Domain",
        min: 0.1,
        max: 2.0,
        step: 0.01,
        category: "CLOUD CONTROLS",
      },
      cloudsIntensity: {
        type: "range",
        label: "Intensity",
        min: 0,
        max: 2.0,
        step: 0.01,
        category: "CLOUD CONTROLS",
      },
      cloudsParallaxAmount: {
        type: "range",
        label: "Parallax",
        min: 0,
        max: 1.0,
        step: 0.01,
        category: "CLOUD CONTROLS",
      },
      cloudsNoiseReduction: {
        type: "range",
        label: "Noise Reduction",
        min: 0,
        max: 0.3,
        step: 0.01,
        category: "CLOUD CONTROLS",
      },

      // Nebula Controls
      nebulaEnabled: {
        type: "checkbox",
        label: "Enable",
        category: "NEBULA CONTROLS",
      },
      nebulaIntensity: {
        type: "range",
        label: "Intensity",
        min: 0,
        max: 3.0,
        step: 0.01,
        category: "NEBULA CONTROLS",
      },
      nebulaFilamentContrast: {
        type: "range",
        label: "Filament",
        min: 0,
        max: 1.0,
        step: 0.01,
        category: "NEBULA CONTROLS",
      },
      nebulaDarkLaneStrength: {
        type: "range",
        label: "Dust",
        min: 0,
        max: 1.0,
        step: 0.01,
        category: "NEBULA CONTROLS",
      },
      nebulaIdleNoiseSpeed: {
        type: "range",
        label: "Speed",
        min: 0,
        max: 0.005,
        step: 0.0001,
        category: "NEBULA CONTROLS",
      },
      nebulaAnisotropy: {
        type: "range",
        label: "Stretch",
        min: 0.5,
        max: 5.0,
        step: 0.1,
        category: "NEBULA CONTROLS",
      },

      // Game Objects
      gameObjectsEnabled: {
        type: "checkbox",
        label: "Enable Game Objects",
        category: "GAME OBJECTS",
      },
      "debugGameObjectCounts.playerShip": {
        type: "range",
        label: "Player Ship Count",
        min: 0,
        max: 20,
        step: 1,
        category: "GAME OBJECTS",
      },
      "debugGameObjectCounts.starport": {
        type: "range",
        label: "Starport Count",
        min: 0,
        max: 15,
        step: 1,
        category: "GAME OBJECTS",
      },
      "gameObjectTypes.playerShip.rotationSpeed": {
        type: "range",
        label: "Player Ship Rotation",
        min: 0,
        max: 0.1,
        step: 0.001,
        category: "GAME OBJECTS",
      },
      "gameObjectTypes.playerShip.scale": {
        type: "range",
        label: "Player Ship Scale",
        min: 0.5,
        max: 5,
        step: 0.1,
        category: "GAME OBJECTS",
      },
      "gameObjectTypes.starport.rotationSpeed": {
        type: "range",
        label: "Starport Rotation",
        min: 0,
        max: 0.1,
        step: 0.001,
        category: "GAME OBJECTS",
      },
      "gameObjectTypes.starport.scale": {
        type: "range",
        label: "Starport Scale",
        min: 0.5,
        max: 5,
        step: 0.1,
        category: "GAME OBJECTS",
      },

      // Warp Effects
      warpDurationSec: {
        type: "range",
        label: "Duration (s)",
        min: 5,
        max: 20,
        step: 1,
        category: "WARP EFFECTS",
      },
      warpFOVMax: {
        type: "range",
        label: "Max FOV",
        min: 60,
        max: 140,
        step: 5,
        category: "WARP EFFECTS",
      },

      // Planet Shadow
      planetShadowEnabled: {
        type: "checkbox",
        label: "Enable Planet Shadow",
        category: "PLANET SHADOW",
      },
      planetPositionX: {
        type: "range",
        label: "Planet Position X",
        min: -100.0,
        max: 100.0,
        step: 1,
        category: "PLANET SHADOW",
      },
      planetPositionY: {
        type: "range",
        label: "Planet Position Y",
        min: -100.0,
        max: 100.0,
        step: 1,
        category: "PLANET SHADOW",
      },
      planetScale: {
        type: "range",
        label: "Planet Scale",
        min: 0.1,
        max: 5.0,
        step: 0.1,
        category: "PLANET SHADOW",
      },
      planetShadowRadius: {
        type: "range",
        label: "Shadow Radius",
        min: 0.1,
        max: 2.0,
        step: 0.01,
        category: "PLANET SHADOW",
      },
      planetShadowOpacity: {
        type: "range",
        label: "Shadow Opacity",
        min: 0,
        max: 1.0,
        step: 0.01,
        category: "PLANET SHADOW",
      },
      planetShadowSoftness: {
        type: "range",
        label: "Shadow Softness",
        min: 0,
        max: 1.0,
        step: 0.01,
        category: "PLANET SHADOW",
      },

      // Terminal Effects
      terminalEnabled: {
        type: "checkbox",
        label: "Enable Terminal Effect",
        category: "TERMINAL EFFECTS",
      },
      terminalIntensity: {
        type: "range",
        label: "Intensity",
        min: 0,
        max: 2.0,
        step: 0.1,
        category: "TERMINAL EFFECTS",
      },
      terminalCellSize: {
        type: "range",
        label: "Cell Size",
        min: 4,
        max: 32,
        step: 1,
        category: "TERMINAL EFFECTS",
      },
      terminalCharacterDensity: {
        type: "range",
        label: "Character Density",
        min: 0.1,
        max: 1.0,
        step: 0.05,
        category: "TERMINAL EFFECTS",
      },
      terminalScanlineIntensity: {
        type: "range",
        label: "Scanline Intensity",
        min: 0,
        max: 1.0,
        step: 0.01,
        category: "TERMINAL EFFECTS",
      },
      terminalScanlineFrequency: {
        type: "range",
        label: "Scanline Frequency",
        min: 0.1,
        max: 2.0,
        step: 0.1,
        category: "TERMINAL EFFECTS",
      },
      terminalContrast: {
        type: "range",
        label: "Contrast",
        min: 0.5,
        max: 2.0,
        step: 0.1,
        category: "TERMINAL EFFECTS",
      },

      // Sharpening Effects
      sharpenEnabled: {
        type: "checkbox",
        label: "Enable Sharpen Effect",
        category: "SHARPENING EFFECTS",
      },
      sharpenIntensity: {
        type: "range",
        label: "Intensity",
        min: 0,
        max: 2.0,
        step: 0.1,
        category: "SHARPENING EFFECTS",
      },
      sharpenRadius: {
        type: "range",
        label: "Radius",
        min: 0.1,
        max: 3.0,
        step: 0.1,
        category: "SHARPENING EFFECTS",
      },
      sharpenThreshold: {
        type: "range",
        label: "Threshold",
        min: 0,
        max: 0.5,
        step: 0.01,
        category: "SHARPENING EFFECTS",
      },

      // Color Adjustment
      colorAdjustEnabled: {
        type: "checkbox",
        label: "Enable Color Adjustment",
        category: "COLOR ADJUSTMENT",
      },
      colorAdjustBrightness: {
        type: "range",
        label: "Brightness",
        min: -1.0,
        max: 1.0,
        step: 0.1,
        category: "COLOR ADJUSTMENT",
      },
      colorAdjustContrast: {
        type: "range",
        label: "Contrast",
        min: 0.5,
        max: 3.0,
        step: 0.1,
        category: "COLOR ADJUSTMENT",
      },
      colorAdjustSaturation: {
        type: "range",
        label: "Saturation",
        min: 0,
        max: 3.0,
        step: 0.1,
        category: "COLOR ADJUSTMENT",
      },
      colorAdjustGamma: {
        type: "range",
        label: "Gamma",
        min: 0.1,
        max: 3.0,
        step: 0.1,
        category: "COLOR ADJUSTMENT",
      },
    };

    // Group controls by category
    const categories = new Map<string, ControlConfig[]>();

    Object.entries(controlMetadata).forEach(([path, metadata]) => {
      const { category } = metadata;
      if (!categories.has(category)) {
        categories.set(category, []);
      }

      const config: ControlConfig = {
        id: this.pathToId(path),
        type: metadata.type,
        label: metadata.label,
        path: path,
        min: metadata.min,
        max: metadata.max,
        step: metadata.step,
      };

      categories.get(category)!.push(config);
    });

    // Generate accordion sections for each category
    categories.forEach((controls, category) => {
      const section = this.createAccordionSection(
        category,
        this.pathToId(category)
      );
      const content = section.querySelector(".accordion-content");

      if (content) {
        controls.forEach((control) => {
          const controlElement = this.createControlItem(control);
          content.appendChild(controlElement);

          // Register control for automatic updates
          this.controlRegistry.set(control.id, {
            element: controlElement,
            config: control,
          });
        });
      }

      this.controlsContent?.appendChild(section);
    });

    // Setup accordion and event listeners
    requestAnimationFrame(() => {
      this.setupAccordion();
      this.setupEventListeners();
      this.refreshAllControls(); // Initial sync
    });
  }

  // ============================================================================
  // DOM CREATION METHODS
  // ============================================================================

  private createControlsPanel(): HTMLElement {
    const panel = this.createElement("div", "controls-panel");
    panel.id = "controlsPanel";

    const header = this.createElement("div", "controls-header");
    header.innerHTML = `
      <span>STARFIELD CONTROLS</span>
      <span id="minimizeButton" style="cursor: pointer">−</span>
    `;

    const content = this.createElement("div", "controls-content");
    content.id = "controlsContent";

    panel.appendChild(header);
    panel.appendChild(content);

    return panel;
  }

  private createElement(tag: string, className: string): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }

  private createControlItem(control: ControlConfig): HTMLElement {
    const item = this.createElement("div", "control-item");

    if (control.type === "button") {
      const button = this.createElement("button", "");
      button.id = control.id;
      button.textContent = control.label;
      button.className = control.className ?? "";

      button.addEventListener("click", () =>
        this.handleButtonClick(control.id)
      );
      item.appendChild(button);
      return item;
    }

    // Create label
    const label = this.createElement("label", "control-label");
    label.textContent = control.label + ":";

    // Create input
    const input = this.createElement("input", "") as HTMLInputElement;
    input.type = control.type;
    input.id = control.id;
    input.className =
      control.type === "checkbox" ? "control-checkbox" : "control-input";

    if (control.type === "range") {
      input.min = control.min?.toString() || "0";
      input.max = control.max?.toString() || "100";
      input.step = control.step?.toString() || "1";
    }

    // Create value display
    const valueSpan = this.createElement("span", "control-value");
    if (control.type === "range") {
      valueSpan.id = control.id + "Value";
      valueSpan.textContent = "0";
    } else if (control.type === "checkbox") {
      valueSpan.className = "control-label";
      valueSpan.textContent = "Enabled";
    }

    item.appendChild(label);
    item.appendChild(input);
    item.appendChild(valueSpan);

    return item;
  }

  private createAccordionSection(title: string, id: string): HTMLElement {
    const section = this.createElement("div", "accordion-section");
    const header = this.createElement("div", "accordion-header");
    header.setAttribute("data-target", id);
    header.innerHTML = `<span>${title}</span><span class="accordion-arrow">▶</span>`;

    const content = this.createElement("div", "accordion-content");
    content.id = id;

    section.appendChild(header);
    section.appendChild(content);
    return section;
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private getElement(id: string): HTMLElement | null {
    try {
      return document.getElementById(id);
    } catch {
      return null;
    }
  }

  private pathToId(path: string): string {
    return path.replace(/\./g, "_");
  }

  private toggleMinimize(): void {
    const content = this.getElement("controlsContent");
    const button = this.getElement("minimizeButton");

    if (content && button) {
      const isMinimized = content.style.display === "none";
      content.style.display = isMinimized ? "block" : "none";
      button.textContent = isMinimized ? "−" : "+";
      button.title = isMinimized ? "Minimize controls" : "Expand controls";
    }
  }

  // ============================================================================
  // CONFIG UPDATE METHODS
  // ============================================================================

  private updateConfigFromControl(controlId: string, value: unknown): void {
    const control = this.controlRegistry.get(controlId);
    if (!control) return;

    const configPath = control.config.path;
    const configUpdate = this.expandConfigPath(configPath, value);

    if (this.starfield.updateConfig) {
      this.starfield.updateConfig(configUpdate);
    }
  }

  private expandConfigPath(
    path: string,
    value: unknown
  ): Record<string, unknown> {
    const keys = path.split(".");
    const result: Record<string, unknown> = {};
    let current: Record<string, unknown> = result;

    for (let i = 0; i < keys.length - 1; i++) {
      current[keys[i]] = {};
      current = current[keys[i]] as Record<string, unknown>;
    }

    current[keys[keys.length - 1]] = value;
    return result;
  }

  private getConfigValue(path: string): unknown {
    const keys = path.split(".");
    let current: unknown = this.starfield.config;

    for (const key of keys) {
      if (current && typeof current === "object" && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private refreshAllControls(): void {
    this.controlRegistry.forEach(({ element, config }) => {
      const value = this.getConfigValue(config.path);
      if (value !== undefined) {
        this.updateControlValue(element, config, value);
      }
    });
  }

  private updateControlValue(
    element: HTMLElement,
    config: ControlConfig,
    value: unknown
  ): void {
    const input = element.querySelector("input") as HTMLInputElement;
    if (!input) return;

    if (config.type === "range") {
      const stringValue = String(value);
      input.value = stringValue;
      const valueSpan = element.querySelector(".control-value");
      if (valueSpan) valueSpan.textContent = stringValue;
    } else if (config.type === "checkbox") {
      input.checked = Boolean(value);
    }
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  private handleButtonClick(buttonId: string): void {
    switch (buttonId) {
      case "idle":
        this.starfield.setAnimationState("idle");
        this.updateButtonStates(buttonId);
        break;
      case "shake":
        this.starfield.setAnimationState("shake");
        this.updateButtonStates(buttonId);
        break;
      case "warping":
        this.starfield.setAnimationState("warping");
        this.updateButtonStates(buttonId);
        break;
      case "pause":
        this.starfield.togglePause();
        this.updatePauseButton();
        break;
      case "logConfig":
        this.starfield.logConfig();
        break;
    }
  }

  private updateButtonStates(activeButtonId: string): void {
    ["idle", "shake", "warping"].forEach((id) => {
      const button = this.getElement(id);
      if (button) button.classList.remove("active");
    });

    const activeButton = this.getElement(activeButtonId);
    if (activeButton) activeButton.classList.add("active");
  }

  private updatePauseButton(): void {
    const pauseBtn = this.getElement("pause");
    if (pauseBtn) {
      if (this.starfield.isPaused) {
        pauseBtn.classList.add("active");
        pauseBtn.textContent = "RESUME";
      } else {
        pauseBtn.classList.remove("active");
        pauseBtn.textContent = "PAUSE";
      }
    }
  }
}
