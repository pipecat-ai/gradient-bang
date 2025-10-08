import useGameStore from "@/stores/game";

/*export const moveToSector = async (
  newSector: Sector,
  bypassAnimation: boolean = false
) => {
  const gameStore = useGameStore.getState();
  const starfield = gameStore.starfieldInstance;

  console.debug("[GAME ACTION] Beginning movement action", newSector);

  // Bypass or await animation sequencing
  if (!bypassAnimation) {
    // Update UI state
    gameStore.setUIState("moving");

    if (!starfield) {
      console.error(
        "[GAME ACTION] Starfield instance not found, bypassing animation"
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } else {
      await starfield?.warpToSector(
        {
          id: newSector.id.toString(),
          config: {},
          gameObjects: newSector.port
            ? [
                {
                  id: newSector.port.code,
                  type: "port",
                  name: newSector.port.code,
                },
              ]
            : [],
        },
        bypassAnimation
      );
    }

    // Return to idle state
    gameStore.setUIState("idle");
  }

  gameStore.setSector(newSector);
};*/

export const startMoveToSector = (
  newSector: Sector,
  options: { bypassAnimation: boolean; bypassFlash: boolean } = {
    bypassAnimation: false,
    bypassFlash: false,
  }
) => {
  const gameStore = useGameStore.getState();
  const starfield = gameStore.starfieldInstance;

  // Store a reference to the sector to be moved to
  // We don't update client to reference the new sector yet
  // to support animation sequencing and debouncing (task-based movement)
  gameStore.setSectorBuffer(newSector);

  console.debug("[GAME ACTION] Starting movement action", newSector);

  gameStore.setUIState("moving");

  if (!starfield) {
    console.error(
      "[GAME ACTION] Starfield instance not found, skipping animation"
    );
    return;
  }

  console.debug("[GAME ACTION] Updating Starfield to", newSector);

  if (!options.bypassAnimation && starfield.isWarpCooldownActive) {
    // Enter auto pilot mode
    // Shaking will stop when any active task completes
    // if starfield.shaking && task.complete, starfield.stopShake();
    starfield.startShake();
  }
  starfield.warpToSector({
    id: newSector.id.toString(),
    bypassAnimation: options.bypassAnimation,
    bypassFlash: options.bypassFlash,
  });
};
