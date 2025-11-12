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

  if (!starfield || !gameStore.settings.renderStarfield) {
    console.error(
      "[GAME ACTION] Starfield instance not found, skipping animation"
    );
    return;
  }

  console.debug("[GAME ACTION] Updating Starfield to", newSector);

  starfield.warpToSector({
    id: newSector.id.toString(),
    gameObjects: newSector.port
      ? [{ id: "port", type: "port", name: "Port" }]
      : undefined,
    bypassAnimation: options.bypassAnimation,
    bypassFlash: options.bypassFlash,
  });
};

/**
 * Compares previous and new map data to find newly discovered sectors.
 * A sector is considered newly discovered when its `visited` property changes
 * from unvisited (undefined/null/empty) to visited (timestamp string).
 *
 * @param prevMapData - The previous map data state
 * @param newMapData - The new map data state
 * @returns Array of newly discovered MapSectorNode objects
 */
export const checkForNewSectors = (
  prevMapData: MapData | null,
  newMapData: MapData
): MapSectorNode[] => {
  // If there's no previous map data, no sectors can be "newly" discovered
  if (!prevMapData) {
    return [];
  }

  const newlyDiscovered: MapSectorNode[] = [];

  // Check each sector in the new map data
  for (const newSector of newMapData) {
    // Find the corresponding sector in the previous map data
    const prevSector = prevMapData.find((s) => s.id === newSector.id);

    // If the sector exists in both maps, check if visited changed from empty to timestamp
    if (prevSector) {
      const wasUnvisited = !prevSector.visited; // falsy (undefined/null/empty)
      const isNowVisited = !!newSector.visited; // truthy (timestamp string)

      if (wasUnvisited && isNowVisited) {
        newlyDiscovered.push(newSector);
      }
    }
  }

  return newlyDiscovered;
};
