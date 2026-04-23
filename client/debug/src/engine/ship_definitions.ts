import type { ShipType } from "./types"

// Ported from `deployment/supabase/migrations/20251109093000_add_ship_purchase_price.sql`
// plus later balance-adjustment migrations
// (20260221 sparrow starter, 20260127 kestrel warp, 20260327 ship balance,
// 20260326 parhelion seeker). Source of truth for "what does a {ship_type}
// look like" at combat load time.

export interface ShipDefinition {
  ship_type: ShipType
  display_name: string
  turns_per_warp: number
  shields: number // max capacity
  fighters: number // max capacity
  cargo_holds: number
  purchase_price: number
  role: string
}

export const SHIP_DEFINITIONS: Record<ShipType, ShipDefinition> = {
  kestrel_courier: {
    ship_type: "kestrel_courier",
    display_name: "Kestrel Courier",
    turns_per_warp: 3,
    shields: 150,
    fighters: 300,
    cargo_holds: 30,
    purchase_price: 25000,
    role: "scout",
  },
  sparrow_scout: {
    ship_type: "sparrow_scout",
    display_name: "Sparrow Scout",
    turns_per_warp: 2,
    shields: 120,
    fighters: 200,
    cargo_holds: 20,
    purchase_price: 20000,
    role: "starter",
  },
  parhelion_seeker: {
    ship_type: "parhelion_seeker",
    display_name: "Parhelion Seeker",
    turns_per_warp: 2,
    shields: 180,
    fighters: 400,
    cargo_holds: 50,
    purchase_price: 65000,
    role: "explorer",
  },
  wayfarer_freighter: {
    ship_type: "wayfarer_freighter",
    display_name: "Wayfarer Freighter",
    turns_per_warp: 3,
    shields: 300,
    fighters: 600,
    cargo_holds: 120,
    purchase_price: 120000,
    role: "main trader",
  },
  pioneer_lifter: {
    ship_type: "pioneer_lifter",
    display_name: "Pioneer Lifter",
    turns_per_warp: 4,
    shields: 200,
    fighters: 500,
    cargo_holds: 180,
    purchase_price: 160000,
    role: "logistics",
  },
  atlas_hauler: {
    ship_type: "atlas_hauler",
    display_name: "Atlas Hauler",
    turns_per_warp: 4,
    shields: 250,
    fighters: 500,
    cargo_holds: 300,
    purchase_price: 260000,
    role: "bulk cargo",
  },
  corsair_raider: {
    ship_type: "corsair_raider",
    display_name: "Corsair Raider",
    // post-balance: agility buff 3 -> 2
    turns_per_warp: 2,
    shields: 400,
    fighters: 1500,
    cargo_holds: 60,
    purchase_price: 180000,
    role: "pirate",
  },
  pike_frigate: {
    ship_type: "pike_frigate",
    display_name: "Pike Frigate",
    turns_per_warp: 3,
    shields: 600,
    fighters: 2000,
    cargo_holds: 70,
    purchase_price: 300000,
    role: "assault",
  },
  bulwark_destroyer: {
    ship_type: "bulwark_destroyer",
    display_name: "Bulwark Destroyer",
    turns_per_warp: 4,
    shields: 1200,
    fighters: 4000,
    cargo_holds: 80,
    purchase_price: 450000,
    role: "line combat",
  },
  aegis_cruiser: {
    ship_type: "aegis_cruiser",
    display_name: "Aegis Cruiser",
    turns_per_warp: 3,
    shields: 1000,
    // post-balance: fighters buff 3500 -> 4000
    fighters: 4000,
    cargo_holds: 90,
    purchase_price: 700000,
    role: "control/escort",
  },
  sovereign_starcruiser: {
    ship_type: "sovereign_starcruiser",
    display_name: "Sovereign Starcruiser",
    turns_per_warp: 3,
    shields: 2000,
    fighters: 6500,
    cargo_holds: 140,
    purchase_price: 2500000,
    role: "flagship",
  },
  escape_pod: {
    ship_type: "escape_pod",
    display_name: "Escape Pod",
    turns_per_warp: 1,
    shields: 0,
    fighters: 0,
    cargo_holds: 0,
    purchase_price: 0,
    role: "lifeboat",
  },
  autonomous_probe: {
    ship_type: "autonomous_probe",
    display_name: "Autonomous Probe",
    turns_per_warp: 1,
    shields: 0,
    fighters: 10,
    cargo_holds: 0,
    purchase_price: 1000,
    role: "autonomous",
  },
  autonomous_light_hauler: {
    ship_type: "autonomous_light_hauler",
    display_name: "Autonomous Light Hauler",
    turns_per_warp: 5,
    shields: 0,
    fighters: 10,
    cargo_holds: 20,
    purchase_price: 5000,
    role: "autonomous",
  },
}

export const DEFAULT_SHIP_TYPE: ShipType = "sparrow_scout"

export function getShipDefinition(type: ShipType): ShipDefinition {
  return SHIP_DEFINITIONS[type]
}
