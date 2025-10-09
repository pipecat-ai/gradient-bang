import useGameStore from "@/stores/game";

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

  starfield.warpToSector({
    id: newSector.id.toString(),
    bypassAnimation: options.bypassAnimation,
    bypassFlash: options.bypassFlash,
  });
};
