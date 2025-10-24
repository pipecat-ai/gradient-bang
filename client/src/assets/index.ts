/**
 * Game Asset Manifest
 *
 * Import all game assets here to ensure they are:
 * 1. Content-hashed by Vite for cache busting
 * 2. Included in the production build
 * 3. Properly typed for TypeScript
 */

// === IMAGES ===
// UI Assets
import uiButtonHover from "../assets/images/ui/button-hover.png";
import uiButton from "../assets/images/ui/button.png";
import uiLoadingScreen from "../assets/images/ui/loading-screen.png";

// Sprites (preload these critical assets)
import playerIdle from "../assets/images/sprites/player-idle.png";
import playerSprite from "../assets/images/sprites/player.png";

// Backgrounds
import menuBackground from "../assets/images/backgrounds/menu.jpg";

// === AUDIO ===
// UI Sounds
import uiClickSound from "../assets/audio/ui/click.mp3";
import uiHoverSound from "../assets/audio/ui/hover.mp3";

// Music
import menuMusic from "../assets/audio/music/menu-theme.mp3";

// === LAZY-LOADED ASSETS ===
// Level 1 (load on demand)
import level1Music from "../assets/audio/music/level-1-theme.mp3";
import level1Background from "../assets/images/backgrounds/level-1.jpg";
import level1Enemy from "../assets/images/sprites/enemy-1.png";

// Level 2 (load on demand)
import level2Music from "../assets/audio/music/level-2-theme.mp3";
import level2Background from "../assets/images/backgrounds/level-2.jpg";
import level2Enemy from "../assets/images/sprites/enemy-2.png";

/**
 * Asset categories for organized loading
 */
export interface AssetManifest {
  preload: {
    images: string[];
    audio: string[];
  };
  lazy: {
    [key: string]: {
      images: string[];
      audio: string[];
    };
  };
}

/**
 * Main asset manifest
 * - preload: Critical assets needed before game starts
 * - lazy: Assets loaded on-demand per level/scene
 */
export const GAME_ASSETS: AssetManifest = {
  // === PRELOAD (Critical - shown during loading screen) ===
  preload: {
    images: [
      uiLoadingScreen,
      uiButton,
      uiButtonHover,
      playerSprite,
      playerIdle,
      menuBackground,
    ],
    audio: [uiClickSound, uiHoverSound, menuMusic],
  },

  // === LAZY LOAD (On-demand per level/scene) ===
  lazy: {
    level1: {
      images: [level1Background, level1Enemy],
      audio: [level1Music],
    },
    level2: {
      images: [level2Background, level2Enemy],
      audio: [level2Music],
    },
  },
};

/**
 * Asset IDs for type-safe references throughout the game
 */
export const ASSET_IDS = {
  images: {
    ui: {
      loadingScreen: uiLoadingScreen,
      button: uiButton,
      buttonHover: uiButtonHover,
    },
    sprites: {
      player: playerSprite,
      playerIdle: playerIdle,
    },
    backgrounds: {
      menu: menuBackground,
      level1: level1Background,
      level2: level2Background,
    },
    enemies: {
      level1: level1Enemy,
      level2: level2Enemy,
    },
  },
  audio: {
    ui: {
      click: uiClickSound,
      hover: uiHoverSound,
    },
    music: {
      menu: menuMusic,
      level1: level1Music,
      level2: level2Music,
    },
  },
} as const;

/**
 * Get all asset paths from the manifest
 */
export function getAllAssetPaths(manifest: AssetManifest): string[] {
  const paths: string[] = [
    ...manifest.preload.images,
    ...manifest.preload.audio,
  ];

  Object.values(manifest.lazy).forEach((group) => {
    paths.push(...group.images, ...group.audio);
  });

  return paths;
}

/**
 * Get total asset count for progress calculation
 */
export function getAssetCount(manifest: AssetManifest): number {
  return getAllAssetPaths(manifest).length;
}

export default GAME_ASSETS;
