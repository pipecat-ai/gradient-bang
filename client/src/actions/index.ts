import useGameStore from "@/stores/game";

export const moveToSector = async (
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
};

export const startMoveToSector = (newSector: Sector) => {
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

  // @TODO: are we moving as part of a task? If so, we bypass animation
  // in favor of the screen 'shake' effect. The Starfield still needs
  // starfield.warpToSector(newSector, true);

  // We could also add some logic here that checks if the starfield is
  // animating, and if so, something is unusual and we can trigger the
  // shake effect vs. stacking animations.
  // if(starfield.state === "warping") {
  //   starfield.startShake();
  //   starfield.warpToSector(newSector, true);
  // } else {
  //   starfield.warpToSector(newSector, false);
  // }

  // Start the Starfield warp animation and update the scene / game objects
  //starfield.warpToSector(newSector, false);
};
