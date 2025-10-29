import { Settings } from "@/dialogs/Settings";
import useGameStore from "@/stores/game";
import { StarField } from "@hud/StarField";
import type { Story } from "@ladle/react";
import { useEffect, useState } from "react";

import "@/css/starfield-ui.css";
import "@/css/starfield.css";
import { GalaxyStarfield } from "@/fx/starfield";

export const Starfield: Story = () => {
  const starfieldInstance = useGameStore.use.starfieldInstance?.();
  const setActiveModal = useGameStore.use.setActiveModal();

  return (
    <>
      <div className="fixed z-99 w-full flex flex-row gap-2">
        <button onClick={() => setActiveModal("settings")}>Settings</button>

        <button
          onClick={() => {
            const starfield = new GalaxyStarfield();
            useGameStore.setState({
              starfieldInstance: starfield,
              gameState: "ready",
            });
            starfield?.initializeScene();
          }}
        >
          Start
        </button>

        <button
          onClick={async () => {
            await starfieldInstance?.warpToSector({
              id: Math.floor(Math.random() * 10000).toString(),
              sceneConfig: {},
            });
            console.log("[WARP COMPLETE]");
          }}
        >
          Change Scene
        </button>

        <button onClick={() => starfieldInstance?.startShake()}>Shake</button>
        <button
          onClick={async () => {
            const gameObjects = starfieldInstance?.getAllGameObjects();
            console.log("All game objects:", gameObjects);

            if (gameObjects && gameObjects.length > 0) {
              // Select the first game object (this triggers dimming and starts look-at animation)
              const firstObject = gameObjects[0];
              console.log(
                "Selecting game object:",
                firstObject.name,
                firstObject.id
              );
              console.log("Selection and look-at animation started");
              await starfieldInstance?.selectGameObject(firstObject.id, {
                zoom: true,
                zoomFactor: 0.5,
              });
              console.log("Selection and look-at animation completed");
            } else {
              console.log("No game objects found");
            }
          }}
        >
          Select First GO
        </button>

        <button
          onClick={() => {
            const cleared = starfieldInstance?.clearGameObjectSelection();
            starfieldInstance?.stopShake();
            console.log("Clear selection result:", cleared);
          }}
        >
          Clear Selection / Shake
        </button>

        <button
          onClick={() => {
            // Add a random NPC (random position auto-generated)
            const id = `npc_${Math.floor(Math.random() * 10000)}`;
            starfieldInstance?.addGameObject({ id, type: "npc", name: "NPC" });
            console.log("Added game object:", id);
          }}
        >
          Add NPC
        </button>

        <button
          onClick={() => {
            const objects = starfieldInstance?.getAllGameObjects() || [];
            if (objects.length === 0) {
              console.log("No objects to remove");
              return;
            }
            const target = objects[0];
            const removed = starfieldInstance?.removeGameObject(target.id);
            console.log("Removed object:", target.id, "=>", removed);
          }}
        >
          Remove First GO
        </button>
      </div>
      <StarField />
      <Settings />
    </>
  );
};

Starfield.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  disconnectedStory: true,
};

export const StarFieldSequence: Story = () => {
  const [start, setStart] = useState(false);
  const [status, setStatus] = useState("");
  const [bypassFlash, setBypassFlash] = useState(false);
  const starfieldInstance = useGameStore.use.starfieldInstance?.();
  const setStarfieldInstance = useGameStore.use.setStarfieldInstance();
  const setGameState = useGameStore.use.setGameState();

  const generateRandomSectorId = () =>
    Math.floor(Math.random() * 10000).toString();

  const resetState = () => {
    starfieldInstance?.clearWarpQueue();
    starfieldInstance?.clearWarpCooldown();
    console.log("[STORY] 🔄 Reset state (cleared queue and cooldown)");
  };

  // Update status every 100ms
  useEffect(() => {
    if (!starfieldInstance || !start) return;

    const updateStatus = () => {
      const queueLength = starfieldInstance.getWarpQueueLength();
      const isInQueue = starfieldInstance.isProcessingWarpQueue;
      const isCooldown = starfieldInstance.isWarpCooldownActive;
      setStatus(
        `Queue: ${queueLength} | Processing: ${isInQueue} | Cooldown: ${isCooldown}`
      );
    };

    const interval = setInterval(updateStatus, 100);
    updateStatus();

    return () => clearInterval(interval);
  }, [starfieldInstance, start]);

  useEffect(() => {
    if (!starfieldInstance || !start) return;

    starfieldInstance.on("sceneReady", (event) => {
      console.log("[STARFIELD EVENT] Scene ready:", event);
    });

    return () => {
      starfieldInstance.off("sceneReady", (event) => {
        console.log("[STARFIELD EVENT] Scene ready:", event);
      });
    };
  }, [starfieldInstance, start]);

  const testScenarios = {
    // Scenario 1: Single warp (should play animation)
    singleWarp: () => {
      console.log("\n[STORY] 🧪 TEST: Single Warp");
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassFlash,
      });
    },

    // Scenario 2: Rapid fire during animation (should queue)
    rapidFireDuringAnimation: () => {
      resetState();
      console.log("\n[STORY] 🧪 TEST: Rapid Fire During Animation");
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassFlash,
      });
      setTimeout(
        () =>
          starfieldInstance?.warpToSector({
            id: generateRandomSectorId(),
            bypassFlash,
          }),
        500
      );
      setTimeout(
        () =>
          starfieldInstance?.warpToSector({
            id: generateRandomSectorId(),
            bypassFlash,
          }),
        1000
      );
      setTimeout(
        () =>
          starfieldInstance?.warpToSector({
            id: generateRandomSectorId(),
            bypassFlash,
          }),
        1500
      );
    },

    // Scenario 3: Call during cooldown (should queue)
    callDuringCooldown: () => {
      resetState();
      console.log("\n[STORY] 🧪 TEST: Call During Cooldown");
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassFlash,
      });
      // Wait for animation to complete (5s) + 1s, then call (should be in cooldown)
      setTimeout(() => {
        console.log("[STORY] Calling during cooldown period...");
        starfieldInstance?.warpToSector({
          id: generateRandomSectorId(),
          bypassFlash,
        });
      }, 6000);
    },

    // Scenario 4: Bypass animation (should load directly)
    bypassAnimation: () => {
      console.log("\n[STORY] 🧪 TEST: Bypass Animation");
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassAnimation: true,
      });
    },

    // Scenario 5: Bypass flash (no visual transition)
    bypassFlash: () => {
      console.log("\n[STORY] 🧪 TEST: Bypass Flash");
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassAnimation: true,
        bypassFlash: true,
      });
    },

    // Scenario 6: Queue buildup then process
    queueBuildup: () => {
      resetState();
      console.log("\n[STORY] 🧪 TEST: Queue Buildup");
      // Start animation
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassFlash,
      });
      // Queue 5 more during animation
      setTimeout(() => {
        for (let i = 0; i < 5; i++) {
          starfieldInstance?.warpToSector({
            id: generateRandomSectorId(),
            bypassFlash,
          });
        }
      }, 1000);
    },

    // Scenario 7: Clear cooldown and warp immediately
    clearCooldownTest: () => {
      resetState();
      console.log("\n[STORY] 🧪 TEST: Clear Cooldown");
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassFlash,
      });
      // Wait 6s (animation done, cooldown active), clear cooldown, then warp
      setTimeout(() => {
        console.log("[STORY] Clearing cooldown...");
        starfieldInstance?.clearWarpCooldown();
        setTimeout(() => {
          console.log("[STORY] Warping after cooldown clear (should animate)");
          starfieldInstance?.warpToSector({
            id: generateRandomSectorId(),
            bypassFlash,
          });
        }, 100);
      }, 6000);
    },

    // Scenario 8: Clear queue mid-processing
    clearQueueTest: () => {
      resetState();
      console.log("\n[STORY] 🧪 TEST: Clear Queue");
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassFlash,
      });
      setTimeout(() => {
        for (let i = 0; i < 3; i++) {
          starfieldInstance?.warpToSector({
            id: generateRandomSectorId(),
            bypassFlash,
          });
        }
        console.log("[STORY] Queue built, clearing in 2s...");
        setTimeout(() => {
          starfieldInstance?.clearWarpQueue();
          console.log("[STORY] Queue cleared");
        }, 2000);
      }, 1000);
    },

    // Scenario 9: Full cycle test (animation → queue → cooldown expire → animate again)
    fullCycleTest: () => {
      resetState();
      console.log("\n[STORY] 🧪 TEST: Full Cycle");
      // Initial animation
      starfieldInstance?.warpToSector({
        id: generateRandomSectorId(),
        bypassFlash,
      });
      // Queue 2 items during animation
      setTimeout(() => {
        starfieldInstance?.warpToSector({
          id: generateRandomSectorId(),
          bypassFlash,
        });
        starfieldInstance?.warpToSector({
          id: generateRandomSectorId(),
          bypassFlash,
        });
      }, 1000);
      // After cooldown expires (animation 5s + cooldown 15s = 20s), warp again
      setTimeout(() => {
        console.log("[STORY] Cooldown should be expired, animating again...");
        starfieldInstance?.warpToSector({
          id: generateRandomSectorId(),
          bypassFlash,
        });
      }, 21000);
    },
  };

  return (
    <div className="relative w-full h-full bg-card">
      <div className="fixed top-4 left-4 z-999 bg-black/80 p-4 rounded-lg text-white space-y-2 max-w-md">
        <div className="text-sm font-mono mb-4">Status: {status}</div>

        <div className="space-y-2">
          <div className="text-xs font-bold text-gray-400">BASIC TESTS</div>
          <button
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm"
            onClick={testScenarios.singleWarp}
          >
            1. Single Warp (Animation)
          </button>
          <button
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm"
            onClick={testScenarios.bypassAnimation}
          >
            2. Bypass Animation
          </button>
          <button
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm"
            onClick={testScenarios.bypassFlash}
          >
            3. Bypass Flash
          </button>
        </div>

        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-gray-400">QUEUE TESTS</div>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={bypassFlash}
                onChange={(e) => setBypassFlash(e.target.checked)}
                className="cursor-pointer"
              />
              <span>Bypass Flash</span>
            </label>
          </div>
          <button
            className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 rounded text-sm"
            onClick={testScenarios.rapidFireDuringAnimation}
          >
            4. Rapid Fire (Queue 4 items)
          </button>
          <button
            className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 rounded text-sm"
            onClick={testScenarios.queueBuildup}
          >
            5. Queue Buildup (6 total)
          </button>
          <button
            className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 rounded text-sm"
            onClick={testScenarios.clearQueueTest}
          >
            6. Clear Queue Mid-Process
          </button>
        </div>

        <div className="space-y-2 pt-2">
          <div className="text-xs font-bold text-gray-400">COOLDOWN TESTS</div>
          <button
            className="w-full px-3 py-2 bg-orange-600 hover:bg-orange-700 rounded text-sm"
            onClick={testScenarios.callDuringCooldown}
          >
            7. Call During Cooldown (6s)
          </button>
          <button
            className="w-full px-3 py-2 bg-orange-600 hover:bg-orange-700 rounded text-sm"
            onClick={testScenarios.clearCooldownTest}
          >
            8. Clear Cooldown Test (6s)
          </button>
        </div>

        <div className="space-y-2 pt-2">
          <div className="text-xs font-bold text-gray-400">COMPREHENSIVE</div>
          <button
            className="w-full px-3 py-2 bg-green-600 hover:bg-green-700 rounded text-sm"
            onClick={testScenarios.fullCycleTest}
          >
            9. Full Cycle (21s test)
          </button>
        </div>

        <div className="pt-2 border-t border-gray-600">
          <button
            className="w-full px-3 py-2 bg-red-600 hover:bg-red-700 rounded text-sm"
            onClick={() => {
              starfieldInstance?.clearWarpQueue();
              starfieldInstance?.clearWarpCooldown();
              console.log("[STORY] 🧹 Cleared queue and cooldown");
            }}
          >
            Reset (Clear Queue + Cooldown)
          </button>
          <button
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-lg"
            onClick={() => {
              const starfield = new GalaxyStarfield();
              setStarfieldInstance(starfield);

              starfield.initializeScene();
              setStart(true);
              setGameState("ready");
            }}
          >
            Start Starfield
          </button>
        </div>
      </div>

      <StarField />
    </div>
  );
};

StarFieldSequence.meta = {
  disconnectedStory: true,
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
};
