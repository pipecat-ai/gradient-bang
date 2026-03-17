import { useEffect } from "react"

import { useConversationStore } from "@/stores/conversation"
import useGameStore from "@/stores/game"

import type { EventLogComponentEntry, SocialReplayCapture } from "./SocialReplayCapture"

export function useStoreCapture(capture: SocialReplayCapture): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []

    // --- Map data (debounced 500ms) ---
    let mapDebounceTimer: ReturnType<typeof setTimeout> | null = null

    unsubs.push(
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

    // --- Ship ---
    unsubs.push(
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
    unsubs.push(
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
    unsubs.push(
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

    // --- Conversation (plain subscribe — no subscribeWithSelector middleware) ---
    let prevMessages = useConversationStore.getState().messages

    unsubs.push(
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

    return () => {
      if (mapDebounceTimer) clearTimeout(mapDebounceTimer)
      unsubs.forEach((unsub) => unsub())
    }
  }, [capture])
}
