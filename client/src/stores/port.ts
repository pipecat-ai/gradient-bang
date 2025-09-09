import { create } from "zustand";

export interface ResourceStock {
  FO: number;
  OG: number;
  EQ: number;
}
export type Resource = "equipment" | "fuel_ore" | "organics";
export type ResourceList = Resource[];

export const ResourceMap = {
  FO: "fuel_ore",
  OG: "organics",
  EQ: "equipment",
} as const;

export interface Port {
  code: string;
  last_seen_prices: Record<Resource, number>;
  last_seen_stock: Record<Resource, number>;
  observed_at: string;
}

interface PortState {
  port?: Port;
  active: boolean;
  setPort: (port: Port) => void;
  setActive: (active: boolean) => void;
  isAtPort: () => boolean;
}

const usePortStore = create<PortState>((set, get) => ({
  port: undefined,
  active: false,
  setPort: (port: Port) => set({ port }),
  setActive: (active: boolean) => set({ active }),
  isAtPort: () => !!get().port,
}));

export default usePortStore;
