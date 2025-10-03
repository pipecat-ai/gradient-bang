declare global {
  interface Player {
    name: string;
    last_active?: string;
  }

  interface Cargo {
    fuel_ore: number;
    organics: number;
    equipment: number;
    [key: string]: number | undefined;
  }

  interface Ship {
    ship_name: string;
    ship_type: string;
    cargo: Cargo;
    cargo_capacity: number;
    cargo_used: number;
    warp_power: number;
    warp_power_capacity: number;
    shields: number;
    max_shields: number;
    fighters: number;
    max_fighters: number;
  }

  interface ResourceStock {
    FO: number;
    OG: number;
    EQ: number;
  }

  type Resource = "equipment" | "fuel_ore" | "organics";
  type ResourceList = Resource[];

  interface Port {
    code: string;
    last_seen_prices: Record<Resource, number>;
    last_seen_stock: Record<Resource, number>;
    observed_at: string;
  }

  interface Sector {
    id: number;
    port?: Port;
    planets?: [];
    adjacent_sectors?: number[];
    last_visited?: string;
  }

  interface SectorCurrent extends Sector {
    other_players?: [];
  }
  interface SectorMap extends Sector {
    sector_id: number;
  }

  type UIState = "idle" | "warping" | "moving" | "plotting" | "trading";
}

export {};
