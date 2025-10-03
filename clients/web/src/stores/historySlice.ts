import type { StateCreator } from "zustand";

export interface MovementHistory {
  timestamp?: string;
  from?: number;
  to: number;
  port?: Port;
}

export interface DiscoveredPort {
  timestamp?: string;
  sector: number;
  port: Port;
}

export interface HistorySlice {
  history: MovementHistory[];
  discoveredPorts: DiscoveredPort[];
  addMovementHistory: (
    prevSectorId: number | undefined,
    newSector: Sector
  ) => void;
  getDiscoveredPorts: () => DiscoveredPort[];
}

export const createHistorySlice: StateCreator<HistorySlice> = (set, get) => ({
  history: [],
  discoveredPorts: [],
  addMovementHistory: (prevSectorId: number | undefined, newSector: Sector) =>
    set((state) => {
      const newHistory = [
        ...state.history,
        {
          timestamp: new Date().toISOString(),
          from: prevSectorId,
          to: newSector.id,
          port: newSector.port,
        },
      ];
      let newDiscoveredPorts = state.discoveredPorts;
      if (newSector.port) {
        const existingPort = state.discoveredPorts.find(
          (dp) => dp.port.code === newSector.port?.code
        );

        if (!existingPort) {
          const discoveredPort: DiscoveredPort = {
            timestamp: new Date().toISOString(),
            sector: newSector.id,
            port: newSector.port,
          };
          newDiscoveredPorts = [...state.discoveredPorts, discoveredPort];
        }
      }

      return {
        history: newHistory,
        discoveredPorts: newDiscoveredPorts,
      };
    }),
  getDiscoveredPorts: () => get().discoveredPorts,
});
