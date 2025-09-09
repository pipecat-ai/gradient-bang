import { create } from "zustand";
import type { Port } from "./port";
import usePortStore from "./port";

interface SectorState {
  sector?: number;
  setSector: (sector: number, sectorContents?: SectorContents) => void;
  sector_contents: SectorContents;
  setSectorContents: (sectorContents: SectorContents) => void;
  getSectorContents: () => SectorContents;
  getSector: () => number | undefined;
  isAtPort: () => boolean;
}

export interface SectorContents {
  port?: Port;
  planets?: [];
  other_players?: [];
  adjacent_sectors: number[];
}

const useSectorStore = create<SectorState>((set, get) => ({
  sector: undefined,
  sector_contents: {
    port: undefined,
    adjacent_sectors: [],
    planets: [],
    other_players: [],
  },
  setSector: (sector: number, sectorContents?: SectorContents) => {
    set({ sector, ...(sectorContents && { sector_contents: sectorContents }) });
    if (sectorContents?.port) {
      usePortStore.getState().setPort(sectorContents.port);
    }
  },
  getSector: () => get().sector,
  setSectorContents: (sectorContents: SectorContents) =>
    set({ sector_contents: sectorContents }),
  getSectorContents: () => get().sector_contents,
  isAtPort: () => !!get().sector_contents.port,
}));

export default useSectorStore;
