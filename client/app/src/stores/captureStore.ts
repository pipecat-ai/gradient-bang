import { create } from "zustand"

import { type EventLogComponentEntry, SocialReplayCapture } from "@/capture/SocialReplayCapture"
import { useConversationStore } from "@/stores/conversation"
import useGameStore from "@/stores/game"

interface CaptureStore {
  capture: SocialReplayCapture | null
  init: () => void
  teardown: () => void
}

// Closure state — not in Zustand because it doesn't need to trigger re-renders
let storeUnsubs: (() => void)[] = []
let settingsUnsub: (() => void) | null = null

function setupStoreSubscriptions(capture: SocialReplayCapture): void {
  teardownStoreSubscriptions()

  // --- Map data (debounced 500ms) ---
  let mapDebounceTimer: ReturnType<typeof setTimeout> | null = null

  storeUnsubs.push(
    useGameStore.subscribe(
      (state) => ({
        local_map_data: state.local_map_data,
        regional_map_data: state.regional_map_data,
        mapCenterSector: state.mapCenterSector,
        course_plot: state.course_plot,
        mapZoomLevel: state.mapZoomLevel,
      }),
      (current) => {
        if (mapDebounceTimer) clearTimeout(mapDebounceTimer)
        mapDebounceTimer = setTimeout(() => {
          const state = useGameStore.getState()
          const ships = state.ships?.data
          const components: EventLogComponentEntry[] = [
            {
              componentId: "starmap",
              renderMode: "snapshot",
              props: {
                map_data: current.local_map_data,
                regional_map_data: current.regional_map_data,
                center_sector_id: current.mapCenterSector ?? state.sector?.id,
                coursePlot: current.course_plot,
                ships,
                mapZoomLevel: current.mapZoomLevel,
              },
              delayMs: 0,
              expectedDurationMs: 500,
            },
          ]
          capture.log("map-update", components)
        }, 500)
      }
    )
  )

  // Clean up map debounce timer on teardown
  storeUnsubs.push(() => {
    if (mapDebounceTimer) clearTimeout(mapDebounceTimer)
  })

  // --- Ship ---
  storeUnsubs.push(
    useGameStore.subscribe(
      (state) => state.ship,
      (ship) => {
        if (!ship?.ship_id) return
        const components: EventLogComponentEntry[] = [
          {
            componentId: "player-ship",
            renderMode: "snapshot",
            props: {
              ship_name: ship.ship_name,
              ship_type: ship.ship_type,
              warp_power: ship.warp_power,
              warp_power_capacity: ship.warp_power_capacity,
              fighters: ship.fighters,
              shields: ship.shields,
              max_shields: ship.max_shields,
              max_fighters: ship.max_fighters,
              credits: ship.credits,
              sector: ship.sector,
              cargo: ship.cargo,
              cargo_capacity: ship.cargo_capacity,
              empty_holds: ship.empty_holds,
            },
            delayMs: 0,
            expectedDurationMs: 100,
          },
        ]
        capture.log("ship-update", components)
      }
    )
  )

  // --- Sector ---
  storeUnsubs.push(
    useGameStore.subscribe(
      (state) => state.sector,
      (sector) => {
        if (!sector) return
        const components: EventLogComponentEntry[] = [
          {
            componentId: "sector-panel",
            renderMode: "sequential",
            props: {
              id: sector.id,
              position: sector.position,
              planets: sector.planets,
              players: sector.players,
              port: sector.port,
              garrison: sector.garrison,
              region: sector.region,
            },
            delayMs: 0,
            expectedDurationMs: 300,
          },
        ]
        capture.log("sector-update", components)
      }
    )
  )

  // --- Combat ---
  storeUnsubs.push(
    useGameStore.subscribe(
      (state) => ({
        session: state.activeCombatSession,
        rounds: state.combatRounds,
        receipts: state.combatActionReceipts,
      }),
      (current) => {
        if (!current.session) return
        const components: EventLogComponentEntry[] = [
          {
            componentId: "combat-panel",
            renderMode: "sequential",
            props: {
              combat_id: current.session.combat_id,
              round: current.session.round,
              participants: current.session.participants,
              garrison: current.session.garrison,
              rounds: current.rounds,
              receipts: current.receipts,
            },
            delayMs: 0,
            expectedDurationMs: 500,
          },
        ]
        capture.log("combat-update", components)
      }
    )
  )

  // --- Conversation ---
  let prevMessages = useConversationStore.getState().messages

  storeUnsubs.push(
    useConversationStore.subscribe((state) => {
      if (state.messages === prevMessages) return
      prevMessages = state.messages

      const components: EventLogComponentEntry[] = [
        {
          componentId: "conversation",
          renderMode: "sequential",
          props: {
            messages: state.messages.map((m) => ({
              role: m.role,
              parts: m.parts?.map((p) => ({
                text: typeof p.text === "string" ? p.text : "[ReactNode]",
                final: p.final,
              })),
              createdAt: m.createdAt,
              final: m.final,
            })),
          },
          delayMs: 0,
          expectedDurationMs: 400,
        },
      ]
      capture.log("conversation-update", components)
    })
  )
}

function teardownStoreSubscriptions(): void {
  storeUnsubs.forEach((unsub) => unsub())
  storeUnsubs = []
}

export const useCaptureStore = create<CaptureStore>()((set, get) => ({
  capture: null,

  init: () => {
    // Avoid double-init
    if (settingsUnsub) return

    const enableCapture = useGameStore.getState().settings.enableCapture

    if (enableCapture) {
      const capture = new SocialReplayCapture()
      setupStoreSubscriptions(capture)
      set({ capture })
      console.debug("%c[CAPTURE] Replay capture started", "color: #00CC66; font-weight: bold;")
    }

    // React to enableCapture setting changes
    settingsUnsub = useGameStore.subscribe(
      (state) => state.settings.enableCapture,
      (enabled) => {
        const current = get().capture
        if (enabled && !current) {
          const capture = new SocialReplayCapture()
          setupStoreSubscriptions(capture)
          set({ capture })
          console.debug("%c[CAPTURE] Replay capture started", "color: #00CC66; font-weight: bold;")
        } else if (!enabled && current) {
          teardownStoreSubscriptions()
          current.destroy()
          set({ capture: null })
        }
      }
    )
  },

  teardown: () => {
    if (settingsUnsub) {
      settingsUnsub()
      settingsUnsub = null
    }
    teardownStoreSubscriptions()
    const current = get().capture
    if (current) {
      current.destroy()
      set({ capture: null })
    }
  },
}))
