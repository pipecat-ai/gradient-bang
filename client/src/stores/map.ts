import { create } from "zustand";
import type { Port } from "./port";
import type { SectorContents } from "./sector";

export interface MapSector extends SectorContents {
  sector_id: number;
  last_visited?: string;
}

export interface IncomingSectorData {
  sector_id: number;
  last_visited?: string;
  port_info?: Port | null;
  planets: unknown[];
  other_players?: unknown[];
  adjacent_sectors: number[];
}

interface MapState {
  sectors: MapSector[];
  addSector: (sector: MapSector) => void;
  getSectors: () => MapSector[];
  getDiscoveredPortSectors: () => MapSector[];
  importSectorsFromData: (
    sectorsData: Record<string, IncomingSectorData>
  ) => void;
}

const useMapStore = create<MapState>((set, get) => ({
  sectors: [],

  addSector: (sector: MapSector) =>
    set((state) => ({ sectors: [...state.sectors, sector] })),

  getSectors: () => get().sectors,

  getDiscoveredPortSectors: () => get().sectors.filter((sector) => sector.port),

  importSectorsFromData: (sectorsData: Record<string, IncomingSectorData>) => {
    const sectors: MapSector[] = [];
    let firstVisit: string | undefined;
    let lastUpdate: string | undefined;

    Object.values(sectorsData).forEach((sectorData: IncomingSectorData) => {
      const port = sectorData.port_info || undefined;

      const sector: MapSector = {
        sector_id: sectorData.sector_id,
        last_visited: sectorData.last_visited,
        port,
        //planets: sectorData.planets || [],
        // other_players: sectorData.other_players || [],
        adjacent_sectors: sectorData.adjacent_sectors || [],
      };

      sectors.push(sector);

      if (sectorData.last_visited) {
        if (!firstVisit || sectorData.last_visited < firstVisit) {
          firstVisit = sectorData.last_visited;
        }
        if (!lastUpdate || sectorData.last_visited > lastUpdate) {
          lastUpdate = sectorData.last_visited;
        }
      }
    });

    const sectorMap = new Map<number, MapSector>();
    sectors.forEach((sector) => {
      const existing = sectorMap.get(sector.sector_id);
      if (
        !existing ||
        (sector.last_visited &&
          existing.last_visited &&
          sector.last_visited > existing.last_visited)
      ) {
        sectorMap.set(sector.sector_id, sector);
      }
    });

    const uniqueSectors = Array.from(sectorMap.values()).sort((a, b) => {
      if (!a.last_visited && !b.last_visited) return 0;
      if (!a.last_visited) return 1;
      if (!b.last_visited) return -1;
      return (
        new Date(b.last_visited).getTime() - new Date(a.last_visited).getTime()
      );
    });

    set({
      sectors: uniqueSectors,
    });
  },
}));

export default useMapStore;
