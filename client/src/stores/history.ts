import { create } from "zustand";
import type { Port } from "./port";

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

interface MovementHistoryState {
  history: MovementHistory[];
  discoveredPorts: DiscoveredPort[];
  addMovementHistory: (history: MovementHistory) => void;
  getDiscoveredPorts: () => DiscoveredPort[];
}

const useMovementHistoryStore = create<MovementHistoryState>((set, get) => ({
  history: [],
  discoveredPorts: [],
  addMovementHistory: (history: MovementHistory) =>
    set((state) => {
      const newHistory = [...state.history, history];
      let newDiscoveredPorts = state.discoveredPorts;
      if (history.port) {
        const existingPort = state.discoveredPorts.find(
          (dp) => dp.port.code === history.port?.code
        );

        if (!existingPort) {
          const discoveredPort: DiscoveredPort = {
            timestamp: history.timestamp,
            sector: history.to,
            port: history.port,
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
}));

export default useMovementHistoryStore;
