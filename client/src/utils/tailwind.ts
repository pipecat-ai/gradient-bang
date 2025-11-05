import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [
        {
          shadow: ["glow-sm"],
        },
      ],
    },
    theme: {
      spacing: ["ui-xs", "ui-md", "ui-sm", "ui-lg", "ui-xl", "ui-2xl"],
    },
  },
} as Parameters<typeof extendTailwindMerge>[0]);

export function cn(...inputs: ClassValue[]) {
  return customTwMerge(clsx(inputs));
}
