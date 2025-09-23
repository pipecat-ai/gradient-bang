import { create } from "zustand";

export interface LocalMapNode {
  id: number;
  visited: boolean;
  port_type?: string | null;
  adjacent: number[];
}

export interface LocalMapPayload {
  character_id?: string;
  sector: number;
  max_hops?: number;
  max_sectors?: number;
  node_list?: LocalMapNode[];
  error?: string;
}

interface LocalMapState {
  maps: Record<string, LocalMapPayload>;
  setLocalMap: (payload: LocalMapPayload) => void;
  getLocalMap: (sector: number, limit: number) => LocalMapPayload | undefined;
  clear: () => void;
}

const keyFor = (sector: number, limit: number) => `${sector}:${limit}`;

const useLocalMapStore = create<LocalMapState>((set, get) => ({
  maps: {},
  setLocalMap: (payload: LocalMapPayload) => {
    if (typeof payload.sector !== "number") {
      return;
    }
    const limit =
      typeof payload.max_sectors === "number"
        ? payload.max_sectors
        : typeof payload.max_hops === "number"
        ? payload.max_hops
        : undefined;
    if (typeof limit !== "number") {
      return;
    }
    const key = keyFor(payload.sector, limit);
    set((state) => ({ maps: { ...state.maps, [key]: payload } }));
  },
  getLocalMap: (sector: number, limit: number) => {
    const key = keyFor(sector, limit);
    return get().maps[key];
  },
  clear: () => set({ maps: {} }),
}));

export default useLocalMapStore;
