/**
 * Shared formatting utilities
 * Extracted from GalaxyStarfield and PerformanceMonitor classes
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Number formatting options */
export interface NumberFormatOptions {
  decimals?: number;
  suffix?: string;
  prefix?: string;
  useThousandsSeparator?: boolean;
}

/** Time formatting options */
export interface TimeFormatOptions {
  includeMilliseconds?: boolean;
  shortFormat?: boolean;
  maxUnit?: "seconds" | "minutes" | "hours" | "days";
}

/** Percentage formatting options */
export interface PercentageFormatOptions {
  decimals?: number;
  includeSign?: boolean;
}

/** Byte size units */
export type ByteSizeUnit = "B" | "KB" | "MB" | "GB" | "TB";

/** File size formatting result */
export interface FileSizeFormat {
  value: number;
  unit: ByteSizeUnit;
  formatted: string;
}

// ============================================================================
// NUMBER FORMATTING FUNCTIONS
// ============================================================================

/**
 * Formats numbers with K/M/B suffixes for display
 */
export function formatNumber(
  num: number,
  options: NumberFormatOptions = {}
): string {
  const {
    decimals = 1,
    prefix = "",
    suffix = "",
    useThousandsSeparator = false,
  } = options;

  if (!isFinite(num)) {
    return "∞";
  }

  let formattedNum: string;
  let unitSuffix = "";

  if (Math.abs(num) >= 1_000_000_000) {
    formattedNum = (num / 1_000_000_000).toFixed(decimals);
    unitSuffix = "B";
  } else if (Math.abs(num) >= 1_000_000) {
    formattedNum = (num / 1_000_000).toFixed(decimals);
    unitSuffix = "M";
  } else if (Math.abs(num) >= 1_000) {
    formattedNum = (num / 1_000).toFixed(decimals);
    unitSuffix = "K";
  } else {
    formattedNum = useThousandsSeparator
      ? num.toLocaleString(undefined, { maximumFractionDigits: decimals })
      : num.toFixed(decimals);
  }

  // Remove trailing zeros after decimal point
  if (formattedNum.includes(".")) {
    formattedNum = formattedNum.replace(/\.?0+$/, "");
  }

  return `${prefix}${formattedNum}${unitSuffix}${suffix}`;
}

/**
 * Formats a number as a percentage
 */
export function formatPercentage(
  value: number,
  options: PercentageFormatOptions = {}
): string {
  const { decimals = 0, includeSign = false } = options;

  if (!isFinite(value)) {
    return "∞%";
  }

  const percentage = value * 100;
  const sign = includeSign && percentage > 0 ? "+" : "";

  return `${sign}${percentage.toFixed(decimals)}%`;
}

/**
 * Formats a number with specified decimal places
 */
export function formatDecimal(num: number, decimals: number = 2): string {
  if (!isFinite(num)) {
    return "∞";
  }

  return num.toFixed(decimals);
}

/**
 * Formats a number with thousands separators
 */
export function formatWithSeparators(
  num: number,
  _separator: string = ",",
  decimals?: number
): string {
  if (!isFinite(num)) {
    return "∞";
  }

  const options: Intl.NumberFormatOptions = {};
  if (decimals !== undefined) {
    options.minimumFractionDigits = decimals;
    options.maximumFractionDigits = decimals;
  }

  return num.toLocaleString(undefined, options);
}

// ============================================================================
// TIME FORMATTING FUNCTIONS
// ============================================================================

/**
 * Formats a time value in seconds to a readable string
 */
export function formatTime(
  seconds: number,
  options: TimeFormatOptions = {}
): string {
  const {
    includeMilliseconds = false,
    shortFormat = false,
    maxUnit = "hours",
  } = options;

  if (!isFinite(seconds) || seconds < 0) {
    return "0s";
  }

  const ms = Math.floor((seconds % 1) * 1000);
  const totalSeconds = Math.floor(seconds);

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const parts: string[] = [];

  // Add time components based on maxUnit
  if (maxUnit === "days" && days > 0) {
    parts.push(
      `${days}${shortFormat ? "d" : " day" + (days !== 1 ? "s" : "")}`
    );
  }

  if ((maxUnit === "days" || maxUnit === "hours") && (hours > 0 || days > 0)) {
    parts.push(
      `${hours}${shortFormat ? "h" : " hour" + (hours !== 1 ? "s" : "")}`
    );
  }

  if (
    (maxUnit === "days" || maxUnit === "hours" || maxUnit === "minutes") &&
    (minutes > 0 || hours > 0 || days > 0)
  ) {
    parts.push(
      `${minutes}${shortFormat ? "m" : " minute" + (minutes !== 1 ? "s" : "")}`
    );
  }

  // Always include seconds
  if (includeMilliseconds && ms > 0) {
    parts.push(
      `${secs}.${ms.toString().padStart(3, "0")}${
        shortFormat ? "s" : " second" + (secs !== 1 ? "s" : "")
      }`
    );
  } else {
    parts.push(
      `${secs}${shortFormat ? "s" : " second" + (secs !== 1 ? "s" : "")}`
    );
  }

  // Return appropriate format
  if (shortFormat) {
    return parts.join(" ");
  } else {
    if (parts.length === 1) {
      return parts[0];
    } else if (parts.length === 2) {
      return parts.join(" and ");
    } else {
      return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1];
    }
  }
}

/**
 * Formats milliseconds to a readable string
 */
export function formatMilliseconds(
  ms: number,
  shortFormat: boolean = true
): string {
  return formatTime(ms / 1000, { includeMilliseconds: true, shortFormat });
}

/**
 * Formats duration between two timestamps
 */
export function formatDuration(
  startTime: number,
  endTime: number = Date.now()
): string {
  const durationMs = endTime - startTime;
  return formatTime(durationMs / 1000, { shortFormat: true });
}

// ============================================================================
// SIZE FORMATTING FUNCTIONS
// ============================================================================

/**
 * Formats byte sizes to human-readable format
 */
export function formatBytes(
  bytes: number,
  decimals: number = 1
): FileSizeFormat {
  if (!isFinite(bytes) || bytes < 0) {
    return { value: 0, unit: "B", formatted: "0 B" };
  }

  const units: ByteSizeUnit[] = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const unit = units[unitIndex];
  const formattedValue =
    unitIndex === 0 ? value.toString() : value.toFixed(decimals);

  return {
    value: parseFloat(formattedValue),
    unit,
    formatted: `${formattedValue} ${unit}`,
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Clamps a number between min and max values
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Rounds a number to the nearest specified precision
 */
export function roundToPrecision(value: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

/**
 * Formats a number as an ordinal (1st, 2nd, 3rd, etc.)
 */
export function formatOrdinal(num: number): string {
  const absNum = Math.abs(num);
  const lastDigit = absNum % 10;
  const lastTwoDigits = absNum % 100;

  let suffix: string;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
    suffix = "th";
  } else {
    switch (lastDigit) {
      case 1:
        suffix = "st";
        break;
      case 2:
        suffix = "nd";
        break;
      case 3:
        suffix = "rd";
        break;
      default:
        suffix = "th";
    }
  }

  return `${num}${suffix}`;
}

/**
 * Formats a number range as a string
 */
export function formatRange(
  min: number,
  max: number,
  separator: string = " - "
): string {
  if (min === max) {
    return formatNumber(min);
  }
  return `${formatNumber(min)}${separator}${formatNumber(max)}`;
}

/**
 * Formats a coordinate pair
 */
export function formatCoordinate(x: number, y: number, z?: number): string {
  const coords = [formatDecimal(x, 1), formatDecimal(y, 1)];

  if (z !== undefined) {
    coords.push(formatDecimal(z, 1));
  }

  return `(${coords.join(", ")})`;
}

/**
 * Truncates text to specified length with ellipsis
 */
export function truncateText(
  text: string,
  maxLength: number,
  ellipsis: string = "..."
): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - ellipsis.length) + ellipsis;
}
