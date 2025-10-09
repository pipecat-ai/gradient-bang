import { produce } from "immer";
import type { StateCreator } from "zustand";

export interface MapSlice {
  sectors: Record<string, Omit<Sector, "id">>;
  addMappedSector: (sector: Sector) => void;
  getMappedSectors: () => Record<string, Omit<Sector, "id">>;
  //getDiscoveredPortSectors: () => Record<string, Omit<Sector, "id">>;
  //setMappedSectors: (sectorsData: Record<string, SectorMap>) => void;
}

export const createMapSlice: StateCreator<MapSlice> = (set, get) => ({
  sectors: {},

  addMappedSector: (sector: Sector) => {
    set(
      produce((state) => {
        const { id, ...sectorData } = sector;
        const sectorId = id.toString();

        if (state.sectors[sectorId]) {
          state.sectors[sectorId].last_visited =
            sectorData.last_visited || new Date().toISOString();
        } else {
          state.sectors[sectorId] = {
            ...sectorData,
            last_visited: sectorData.last_visited || new Date().toISOString(),
          };
        }
      })
    );
  },

  getMappedSectors: () => get().sectors,
  /*getDiscoveredPortSectors: () => {
    const sectors = get().sectors;
    return Object.fromEntries(
      Object.entries(sectors).filter(([, sector]) => sector.port)
    );
  },
  setMappedSectors: (sectorsData: Record<string, SectorMap>) => {
    const sectorsMap: Record<string, Omit<Sector, "id">> = {};

    Object.values(sectorsData).forEach((sectorData: SectorMap) => {
      const port = sectorData.port || undefined;
      const sectorId = sectorData.sector_id.toString();
      const sectorDataWithoutId: Omit<Sector, "id"> = {
        last_visited: sectorData.last_visited,
        port,
        adjacent_sectors: sectorData.adjacent_sectors || [],
      };
      const existing = sectorsMap[sectorId];
      if (
        !existing ||
        (sectorData.last_visited &&
          existing.last_visited &&
          sectorData.last_visited > existing.last_visited)
      ) {
        sectorsMap[sectorId] = sectorDataWithoutId;
      }
    });

    set({
      sectors: sectorsMap,
    });
  },*/
});
