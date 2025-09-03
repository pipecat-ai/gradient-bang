import { GalaxyStarfield } from "./Starfield";
import { type GameObjectInstance } from "./types/GameObject";

import "./styles.css";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Debug commands interface */
interface DebugCommands {
  enable: () => void;
  disable: () => void;
  toggle: () => void;
  controls: () => void;
  config: () => void;
  performance: () => void;
  objects: () => void;
  pause: () => void;
}

/** Window extensions for debugging */
declare global {
  interface Window {
    starfield: GalaxyStarfield;
    debugCommands: DebugCommands;
    debug: DebugCommands;
  }
}

const DEBUG_MODE = true;

// Initialize the starfield scene
const starfield = new GalaxyStarfield(
  {
    debugMode: DEBUG_MODE,
  },
  {
    onGameObjectInView: (gameObject: GameObjectInstance) => {
      console.log("Game object in view:", gameObject);
    },
    onGameObjectSelected: (gameObject: GameObjectInstance) => {
      console.log("Game object selected:", gameObject);
    },
    onGameObjectCleared: () => {
      console.log("Game object selection cleared");
    },
    onWarpStart: () => {
      console.log("Warp animation started");
    },
    onWarpComplete: () => {
      console.log("Warp animation completed");
    },
    onWarpCancel: () => {
      console.log("Warp animation cancelled");
    },
  }
);

// Always expose starfield to window for console access
window.starfield = starfield;

if (DEBUG_MODE) {
  document.addEventListener("DOMContentLoaded", () => {
    console.debug(
      "DOMContentLoaded event fired - initializing keyboard controls"
    );

    // Keyboard controls for testing
    document.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "1": {
          // Select first player ship
          const ships = starfield.getGameObjectsByType("playerShip");
          if (ships.length > 0) {
            starfield.selectGameObject(ships[0].id);
            console.debug("Selected first player ship");
          }
          break;
        }
        case "2": {
          // Select first starport
          const starports = starfield.getGameObjectsByType("starport");
          if (starports.length > 0) {
            starfield.selectGameObject(starports[0].id);
            console.debug("Selected first starport");
          }
          break;
        }
        case "0":
          // Clear selection
          starfield.clearGameObjectSelection();
          console.debug("Selection cleared");
          break;
        case "l":
        case "L": {
          // List all objects
          const objects = starfield.getAllGameObjects();
          console.debug("All Game Objects:", objects);
          break;
        }
        case "F12":
          // Toggle debug mode
          e.preventDefault(); // Prevent browser dev tools
          starfield.toggleDebugMode();
          break;
        case "w":
        case "W":
          // Trigger warp animation
          starfield.startWarp();
          console.debug("Warp animation triggered");
          break;
        case "s":
        case "S":
          // Test scene manager directly
          if (starfield.sceneManager) {
            const newConfig = starfield.sceneManager.create();
            starfield.reloadConfig(newConfig);
            console.debug("New scene created directly via SceneManager");
          } else {
            console.debug("SceneManager not available");
          }
          break;
        case "t":
        case "T":
          starfield.warpToSector({
            id: "testSector",
            config: {
              gameObjects: [
                {
                  id: "command_ship",
                  type: "playerShip",
                  position: { x: 50, y: 30, z: -100 },
                  rotation: { x: 0, y: 0, z: 0 },
                  scale: 1.0,
                  metadata: {
                    faction: "Federation",
                    level: 10,
                    name: "Command Vessel Alpha",
                  },
                },
                {
                  id: "escort_ship",
                  type: "player",
                  position: { x: -60, y: -20, z: -80 },
                  rotation: { x: 0, y: 0, z: 0 },
                  scale: 1.0,
                  metadata: {
                    name: "Escort Beta",
                  },
                },
                {
                  id: "trade_station",
                  type: "starport",
                  position: { x: 0, y: 100, z: -150 },
                  rotation: { x: 0, y: 0, z: 0 },
                  scale: 1.2,
                  metadata: {
                    name: "Trading Post Gamma",
                  },
                },
                {
                  id: "patrol_1",
                  type: "npc",
                  position: { x: 80, y: 60, z: -120 },
                  rotation: { x: 0, y: 0, z: 0 },
                  scale: 1.0,
                  metadata: {
                    name: "Security Patrol",
                  },
                },
                {
                  id: "patrol_2",
                  type: "npc",
                  position: { x: -90, y: 40, z: -90 },
                  rotation: { x: 0, y: 0, z: 0 },
                  scale: 1.0,
                  metadata: {
                    name: "Border Guard",
                  },
                },
              ],
            },
          });
          break;
      }
    });
    console.debug(
      "Keyboard shortcuts: 1=select ship, 2=select starport, 0=clear, L=list objects, F12=toggle debug, D=test dim, U=test undim, W=warp, S=new scene, T=warp to testSector"
    );
  });
}
