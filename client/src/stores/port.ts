import { create } from "zustand";

import PortImageSSB from "../images/ports/SSB.png";

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

/**
export interface Port {
  class: number;
  code: string;
  stock: ResourceStock;
  max_capacity: ResourceStock;
  buys: ResourceList;
  sells: ResourceList;
  prices: Record<Resource, number>;
}**/

export interface Port {
  code: string;
  last_seen_prices: Record<Resource, number>;
  last_seen_stock: Record<Resource, number>;
  observed_at: string;
}

const portImageMap = {
  SSB: PortImageSSB,
};

interface PortState {
  port?: Port;
  setPort: (port: Port) => void;
  getPortImage: (code: string) => string | undefined;
}

const usePortStore = create<PortState>((set) => ({
  port: undefined,
  setPort: (port: Port) => set({ port }),
  getPortImage: (code: string) =>
    portImageMap[code as keyof typeof portImageMap],
}));

export default usePortStore;
