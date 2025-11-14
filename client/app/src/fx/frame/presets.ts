/**
 * Performance presets for different device capabilities
 */
export const PERFORMANCE_PRESETS = {
  low: {
    maxDPR: 1.5,
    shadowBlur: 0,
  },
  mid: {
    maxDPR: 2.0,
    shadowBlur: 0.5,
  },
  high: {
    maxDPR: 2.5,
    shadowBlur: 1.5,
  },
} as const;
