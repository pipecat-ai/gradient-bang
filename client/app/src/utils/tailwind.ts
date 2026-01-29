import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [
        {
          shadow: ["glow-sm", "xshort", "short", "long", "xlong"],
        },
      ],
      "stripe-frame": [
        {
          "stripe-frame": ["ui-xs", "ui-sm", "ui-md", "ui-lg", "ui-xl", "ui-2xl"],
        },
      ],
      "elbow-offset": [
        {
          "elbow-offset": [(value: string) => !isNaN(Number(value))],
        },
      ],
      "elbow-size": [
        {
          "elbow-size": [(value: string) => !isNaN(Number(value))],
        },
      ],
      elbow: [
        {
          elbow: [(value: string) => isNaN(Number(value))],
        },
      ],
      "bracket-offset": [
        {
          "bracket-offset": [(value: string) => !isNaN(Number(value))],
        },
      ],
      "bracket-size": [
        {
          "bracket-size": [(value: string) => !isNaN(Number(value))],
        },
      ],
      bracket: [
        {
          bracket: [(value: string) => isNaN(Number(value))],
        },
      ],
    },
    theme: {
      spacing: ["ui-xs", "ui-md", "ui-sm", "ui-lg", "ui-xl", "ui-2xl"],
      text: ["xxs"],
    },
  },
} as Parameters<typeof extendTailwindMerge>[0])

export function cn(...inputs: ClassValue[]) {
  return customTwMerge(clsx(inputs))
}
