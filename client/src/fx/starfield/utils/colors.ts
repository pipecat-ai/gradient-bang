/**
 * Shared color utilities
 * Extracted from GalaxyStarfield class and enhanced with additional features
 */

import { type NebulaPalette } from "../constants";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** HSL color representation */
export interface HSLColor {
  h: number; // Hue (0-1)
  s: number; // Saturation (0-1)
  l: number; // Lightness (0-1)
}

/** Color conversion result that might fail */
export type ColorConversionResult<T> = T | null;

/** Terminal color presets */
export interface TerminalColors {
  green: RGBColor;
  amber: RGBColor;
  blue: RGBColor;
  cyan: RGBColor;
  purple: RGBColor;
}

/** Nebula color collections */
export interface NebulaColors {
  tealOrange: NebulaPalette;
  magentaGreen: NebulaPalette;
  blueGold: NebulaPalette;
}

/** Complete color presets collection */
export interface ColorPresets {
  terminal: TerminalColors;
  nebula: NebulaColors;
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validates RGB color object
 */
export function validateRgb(color: RGBColor): boolean;
export function validateRgb(r: number, g: number, b: number): boolean;
export function validateRgb(
  colorOrR: RGBColor | number,
  g?: number,
  b?: number
): boolean {
  if (typeof colorOrR === "object" && colorOrR !== null) {
    const { r, g, b } = colorOrR;
    return validateRgbComponents(r, g, b);
  }

  if (
    typeof colorOrR === "number" &&
    typeof g === "number" &&
    typeof b === "number"
  ) {
    return validateRgbComponents(colorOrR, g, b);
  }

  return false;
}

/**
 * Validates individual RGB components
 */
function validateRgbComponents(r: number, g: number, b: number): boolean {
  return (
    typeof r === "number" &&
    r >= 0 &&
    r <= 1 &&
    typeof g === "number" &&
    g >= 0 &&
    g <= 1 &&
    typeof b === "number" &&
    b >= 0 &&
    b <= 1
  );
}

/**
 * Validates HSL color values
 */
export function validateHsl(color: HSLColor): boolean;
export function validateHsl(h: number, s: number, l: number): boolean;
export function validateHsl(
  colorOrH: HSLColor | number,
  s?: number,
  l?: number
): boolean {
  if (typeof colorOrH === "object" && colorOrH !== null) {
    const { h, s, l } = colorOrH;
    return validateHslComponents(h, s, l);
  }

  if (
    typeof colorOrH === "number" &&
    typeof s === "number" &&
    typeof l === "number"
  ) {
    return validateHslComponents(colorOrH, s, l);
  }

  return false;
}

/**
 * Validates individual HSL components
 */
function validateHslComponents(h: number, s: number, l: number): boolean {
  return (
    typeof h === "number" &&
    h >= 0 &&
    h <= 1 &&
    typeof s === "number" &&
    s >= 0 &&
    s <= 1 &&
    typeof l === "number" &&
    l >= 0 &&
    l <= 1
  );
}

/**
 * Validates hex color string
 */
export function validateHex(hex: string): boolean {
  return /^#?([a-f\d]{3}){1,2}$/i.test(hex);
}

// ============================================================================
// CONVERSION FUNCTIONS
// ============================================================================

/**
 * Converts RGB values (0-1) to hex color string
 */
export function rgbToHex(color: RGBColor): string;
export function rgbToHex(r: number, g: number, b: number): string;
export function rgbToHex(
  colorOrR: RGBColor | number,
  g?: number,
  b?: number
): string {
  let r: number, gVal: number, bVal: number;

  if (typeof colorOrR === "object") {
    ({ r, g: gVal, b: bVal } = colorOrR);
  } else {
    r = colorOrR;
    gVal = g!;
    bVal = b!;
  }

  const toHex = (c: number): string => {
    const hex = Math.round(Math.max(0, Math.min(255, c * 255))).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };

  return "#" + toHex(r) + toHex(gVal) + toHex(bVal);
}

/**
 * Converts hex color string to RGB object
 */
export function hexToRgb(hex: string): ColorConversionResult<RGBColor> {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16) / 255,
        g: parseInt(result[2], 16) / 255,
        b: parseInt(result[3], 16) / 255,
      }
    : null;
}

/**
 * Converts RGB to HSL
 */
export function rgbToHsl(color: RGBColor): HSLColor;
export function rgbToHsl(r: number, g: number, b: number): HSLColor;
export function rgbToHsl(
  colorOrR: RGBColor | number,
  g?: number,
  b?: number
): HSLColor {
  let r: number, gVal: number, bVal: number;

  if (typeof colorOrR === "object") {
    ({ r, g: gVal, b: bVal } = colorOrR);
  } else {
    r = colorOrR;
    gVal = g!;
    bVal = b!;
  }

  const max = Math.max(r, gVal, bVal);
  const min = Math.min(r, gVal, bVal);
  let h: number;
  let s: number;
  const l = (max + min) / 2;

  if (max === min) {
    h = s = 0; // achromatic
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (gVal - bVal) / d + (gVal < bVal ? 6 : 0);
        break;
      case gVal:
        h = (bVal - r) / d + 2;
        break;
      case bVal:
        h = (r - gVal) / d + 4;
        break;
      default:
        h = 0;
    }
    h /= 6;
  }

  return { h, s, l };
}

/**
 * Converts HSL to RGB
 */
export function hslToRgb(color: HSLColor): RGBColor;
export function hslToRgb(h: number, s: number, l: number): RGBColor;
export function hslToRgb(
  colorOrH: HSLColor | number,
  s?: number,
  l?: number
): RGBColor {
  let h: number, sVal: number, lVal: number;

  if (typeof colorOrH === "object") {
    ({ h, s: sVal, l: lVal } = colorOrH);
  } else {
    h = colorOrH;
    sVal = s!;
    lVal = l!;
  }

  let r: number, g: number, b: number;

  if (sVal === 0) {
    r = g = b = lVal; // achromatic
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = lVal < 0.5 ? lVal * (1 + sVal) : lVal + sVal - lVal * sVal;
    const p = 2 * lVal - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return { r, g, b };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Normalizes RGB values to 0-1 range
 */
export function normalizeRgb(color: RGBColor): RGBColor;
export function normalizeRgb(r: number, g: number, b: number): RGBColor;
export function normalizeRgb(
  colorOrR: RGBColor | number,
  g?: number,
  b?: number
): RGBColor {
  if (typeof colorOrR === "object") {
    const { r, g, b } = colorOrR;
    return {
      r: Math.max(0, Math.min(1, r)),
      g: Math.max(0, Math.min(1, g)),
      b: Math.max(0, Math.min(1, b)),
    };
  }

  return {
    r: Math.max(0, Math.min(1, colorOrR)),
    g: Math.max(0, Math.min(1, g!)),
    b: Math.max(0, Math.min(1, b!)),
  };
}

/**
 * Interpolates between two RGB colors
 */
export function interpolateRgb(
  color1: RGBColor,
  color2: RGBColor,
  factor: number
): RGBColor {
  // Clamp factor to 0-1 range
  const t = Math.max(0, Math.min(1, factor));

  return {
    r: color1.r + (color2.r - color1.r) * t,
    g: color1.g + (color2.g - color1.g) * t,
    b: color1.b + (color2.b - color1.b) * t,
  };
}

/**
 * Creates a safe RGB color with fallback
 */
export function createSafeRgbColor(
  r: number | undefined,
  g: number | undefined,
  b: number | undefined,
  fallback: RGBColor = { r: 1, g: 1, b: 1 }
): RGBColor {
  if (r === undefined || g === undefined || b === undefined) {
    return fallback;
  }

  if (!validateRgb(r, g, b)) {
    return fallback;
  }

  return { r, g, b };
}

/**
 * Blends two colors using a specified blend mode
 */
export function blendColors(
  base: RGBColor,
  overlay: RGBColor,
  opacity: number = 1
): RGBColor {
  const alpha = Math.max(0, Math.min(1, opacity));

  return {
    r: base.r + (overlay.r - base.r) * alpha,
    g: base.g + (overlay.g - base.g) * alpha,
    b: base.b + (overlay.b - base.b) * alpha,
  };
}

/**
 * Gets luminance of an RGB color (0-1)
 */
export function getLuminance(color: RGBColor): number {
  // Using relative luminance formula
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

/**
 * Determines if a color is considered "dark" (luminance < 0.5)
 */
export function isDarkColor(color: RGBColor): boolean {
  return getLuminance(color) < 0.5;
}

/**
 * Gets a contrasting color (white or black) for the given color
 */
export function getContrastingColor(color: RGBColor): RGBColor {
  return isDarkColor(color)
    ? { r: 1, g: 1, b: 1 } // White for dark colors
    : { r: 0, g: 0, b: 0 }; // Black for light colors
}

// ============================================================================
// COLOR PRESETS
// ============================================================================

/**
 * Predefined color presets for common use cases
 */
export const ColorPresets: ColorPresets = {
  // Terminal colors
  terminal: {
    green: { r: 0.0, g: 1.0, b: 0.0 },
    amber: { r: 1.0, g: 0.75, b: 0.0 },
    blue: { r: 0.0, g: 0.7, b: 1.0 },
    cyan: { r: 0.0, g: 1.0, b: 1.0 },
    purple: { r: 0.8, g: 0.4, b: 1.0 },
  },

  // Nebula colors
  nebula: {
    tealOrange: {
      name: "tealOrange",
      c1: { r: 0.1, g: 0.65, b: 0.7 },
      c2: { r: 0.98, g: 0.58, b: 0.2 },
      mid: { r: 0.8, g: 0.75, b: 0.65 },
    },
    magentaGreen: {
      name: "magentaGreen",
      c1: { r: 0.75, g: 0.15, b: 0.75 },
      c2: { r: 0.2, g: 0.85, b: 0.45 },
      mid: { r: 0.6, g: 0.55, b: 0.7 },
    },
    blueGold: {
      name: "blueGold",
      c1: { r: 0.15, g: 0.35, b: 0.95 },
      c2: { r: 0.95, g: 0.78, b: 0.25 },
      mid: { r: 0.7, g: 0.72, b: 0.8 },
    },
  },
};
