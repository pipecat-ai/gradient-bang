import { type ReactNode, useCallback, useEffect, useMemo } from "react"

import { RTVIEvent } from "@pipecat-ai/client-js"
import { usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react"

import { GameContext } from "@/hooks/useGameContext"
import useAudioStore from "@/stores/audio"
import { useConversationStore } from "@/stores/conversation"
import useGameStore, { GameInitStateMessage } from "@/stores/game"
import {
  applyCombatActionAcceptedState,
  applyCombatEndedState,
  applyCombatRoundResolvedState,
  applyCombatRoundWaitingState,
  applyShipDestroyedState,
} from "@/utils/combat"
import {
  salvageCollectedSummaryString,
  salvageCreatedSummaryString,
  transferSummaryString,
} from "@/utils/game"
import { hasDeviatedFromCoursePlot } from "@/utils/map"

import type * as Msg from "@/types/messages"

interface GameProviderProps {
  children: ReactNode
}

export function GameProvider({ children }: GameProviderProps) {
  const client = usePipecatClient()
  const playerSessionId = useGameStore((state) => state.playerSessionId)
  const dispatchAction = useGameStore((state) => state.dispatchAction)

  useEffect(() => {
    console.debug(
      "%c[GAME INIT] Settings",
      "background-color: #000000; color: #ffffff; font-weight: bold",
      useGameStore.getState().settings
    )
  }, [])

  /**
   * Send user text input to server
   */
  const sendUserTextInput = useCallback(
    (text: string) => {
      if (!client) {
        console.error("[GAME CONTEXT] Client not available")
        return
      }
      if (client.state !== "ready") {
        console.error(`[GAME CONTEXT] Client not ready. Current state: ${client.state}`)
        return
      }
      console.debug(`[GAME CONTEXT] Sending user text input: "${text}"`)
      client.sendClientMessage("user-text-input", { text })
    },
    [client]
  )

  /**
   * Initialization method
   */
  const initialize = useCallback(async () => {
    console.debug("[GAME CONTEXT] Initializing...")

    // Setters and store methods are stable references — pull them once.
    const { setPlayerSessionId, setGameStateMessage, setGameState, getBotStartParams, settings } =
      useGameStore.getState()

    // Set initial state
    setPlayerSessionId(null)
    setGameStateMessage(GameInitStateMessage.INIT)
    setGameState("initializing")

    // 1. Construct and await heavier game instances
    if (settings.renderStarfield) {
      console.debug("[GAME CONTEXT] Waiting on Starfield ready...")
      await new Promise<void>((resolve) => {
        if (useGameStore.getState().starfieldReady) {
          resolve()
          return
        }
        const unsubscribe = useGameStore.subscribe(
          (state) => state.starfieldReady,
          (starfieldReady) => {
            if (starfieldReady) {
              unsubscribe()
              resolve()
            }
          }
        )
      })
    }

    // 2. Connect to agent
    setGameStateMessage(GameInitStateMessage.CONNECTING)

    const { character_id: characterId, access_token: accessToken } = useGameStore.getState()
    if (!characterId || !accessToken) {
      throw new Error("Attempting to connect to bot without a character ID or access token")
    }
    const botStartParams = getBotStartParams(characterId, accessToken)

    console.debug("[GAME CONTEXT] Connecting with params", botStartParams)

    try {
      await client?.startBotAndConnect(botStartParams)
      if (!client?.connected) {
        throw new Error("Failed to connect to game server")
      }
    } catch {
      console.error("[GAME CONTEXT] Error connecting to game server")
      setGameState("error")
      return
    }

    // 3. Wait for initial data and initialize anything that needs it
    // @TODO: pass initial config to starfield here
    console.debug("[GAME CONTEXT] Initialized, setting ready state")
    setGameStateMessage(GameInitStateMessage.READY)
    setGameState("ready")
  }, [client])

  /**
   * Handle server message
   */
  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (e: Msg.ServerMessage) => {
        if ("event" in e) {
          console.debug("[GAME EVENT] Server message received", e.event, e)

          // Helper functions
          const getPayloadPlayerId = (payload: Msg.ServerMessagePayload): string | undefined => {
            if (payload.player && typeof payload.player.id === "string" && payload.player.id) {
              return payload.player.id
            }
            return undefined
          }

          const getPayloadShipId = (payload: Msg.ServerMessagePayload): string | undefined => {
            if (typeof payload.ship_id === "string" && payload.ship_id) {
              return payload.ship_id
            }
            const ship = payload.ship
            if (ship && typeof ship === "object") {
              const shipId = (ship as { ship_id?: unknown }).ship_id
              if (typeof shipId === "string" && shipId) {
                return shipId
              }
            }
            return undefined
          }

          const getPayloadSectorId = (payload: Msg.ServerMessagePayload): number | undefined => {
            const sector = payload.sector
            if (typeof sector === "number") {
              return sector
            }
            if (sector && typeof sector === "object") {
              const sectorId = (sector as { id?: unknown }).id
              if (typeof sectorId === "number") {
                return sectorId
              }
            }
            return undefined
          }

          const isKnownFleetShip = (shipId: string | undefined): boolean => {
            if (!shipId) {
              return false
            }
            const ships = useGameStore.getState().ships.data ?? []
            return ships.some((ship) => ship.ship_id === shipId)
          }

          const isCorporationShipPayload = (payload: Msg.ServerMessagePayload): boolean => {
            const player = payload.player
            if (
              player &&
              typeof player === "object" &&
              (player as { player_type?: unknown }).player_type === "corporation_ship"
            ) {
              return true
            }

            const ship = payload.ship
            if (
              ship &&
              typeof ship === "object" &&
              (ship as { owner_type?: unknown }).owner_type === "corporation"
            ) {
              return true
            }

            return isKnownFleetShip(getPayloadShipId(payload))
          }

          const upsertCorporationShip = (
            shipId: string,
            shipUpdate: Partial<ShipSelf> = {}
          ): void => {
            const store = useGameStore.getState()
            const hasShip = (store.ships.data ?? []).some((ship) => ship.ship_id === shipId)
            if (hasShip) {
              store.updateShip({
                ...shipUpdate,
                ship_id: shipId,
              })
              return
            }
            store.addShip({
              ...shipUpdate,
              ship_id: shipId,
              owner_type: "corporation",
            })
          }

          const normalizeTaskId = (value: unknown): string | undefined => {
            if (typeof value !== "string") {
              return undefined
            }
            const trimmed = value.trim()
            return trimmed || undefined
          }

          const getTaskIdCandidates = (
            eventMessage: Msg.ServerMessage,
            payload: Msg.ServerMessagePayload
          ): string[] => {
            const eventWithShort = eventMessage as Msg.ServerMessage & { task_short_id?: string }
            const payloadTaskId =
              payload && typeof payload === "object" ?
                normalizeTaskId((payload as Record<string, unknown>).task_id)
              : undefined
            const payloadTaskShortId =
              payload && typeof payload === "object" ?
                normalizeTaskId((payload as Record<string, unknown>).task_short_id)
              : undefined

            return Array.from(
              new Set(
                [
                  normalizeTaskId(eventMessage.task_id),
                  normalizeTaskId(eventWithShort.task_short_id),
                  payloadTaskId,
                  payloadTaskShortId,
                ].filter((taskId): taskId is string => !!taskId)
              )
            )
          }

          const logMissingPlayerId = (eventName: string, payload: Msg.ServerMessagePayload) => {
            console.warn(`[GAME EVENT] Missing player.id for ${eventName}`, payload)
          }

          const logIgnored = (
            eventName: string,
            reason: string,
            payload: Msg.ServerMessagePayload
          ) => {
            console.debug(
              `%c[GAME EVENT] Ignoring ${eventName} (${reason})`,
              "color: #000; background: #CCC",
              payload
            )
          }

          const isPlayerSessionPayload = (
            eventName: string,
            payload: Msg.ServerMessagePayload
          ): boolean => {
            const eventPlayerId = getPayloadPlayerId(payload)
            if (!eventPlayerId) {
              logMissingPlayerId(eventName, payload)
              return false
            }
            if (eventPlayerId !== useGameStore.getState().playerSessionId) {
              logIgnored(eventName, `player ${eventPlayerId}`, payload)
              return false
            }
            return true
          }

          // --- EVENT HANDLERS ---

          switch (e.event) {
            // ----- VERSION
            case "session.version": {
              const { version } = e.payload as { version: string }
              console.log(
                `%cGradient Bang v${version}`,
                "background: #000; color: #fff; padding: 4px 8px; border-radius: 4px; font-weight: bold;"
              )
              break
            }

            // ----- STATUS
            case "status.snapshot":
            case "status.update": {
              console.debug("[GAME EVENT] Status update", e.payload)

              const status = e.payload as Msg.StatusMessage

              if (e.event === "status.snapshot" && status.player.player_type === "human") {
                if (!status.player.id) {
                  logMissingPlayerId(e.event, status)
                }
              }

              // Initialize game client if this is the first status update
              if (status.source?.method === "join") {
                // Note: we only mutate when `playerSessionId` is null retain
                // a source of truth on client creation
                if (!useGameStore.getState().playerSessionId) {
                  console.debug(
                    "%c[GAME EVENT] status.update join event, setting player session ID",
                    "color: #ffffff; background: #000000",
                    status.player.id
                  )
                  useGameStore.getState().setPlayerSessionId(status.player.id)
                }
                // Backfill character_id when it wasn't set during login
                // (e.g. Ladle dev environment skips character select).
                if (!useGameStore.getState().character_id && status.player.id) {
                  useGameStore.getState().setCharacterId(status.player.id)
                }
              }

              // Handle status update accordingly
              if (isPlayerSessionPayload(e.event, status)) {
                if (status.source?.method === "join") {
                  useGameStore.getState().addActivityLogEntry({
                    type: "join",
                    message: "Joined the game",
                  })
                }
                // Update store — corporation goes through setCorporation
                // so ship upsert/strip logic runs (same as corporation.data).
                useGameStore.getState().setState({
                  player: status.player,
                  ship: status.ship,
                  sector: status.sector,
                })
                useGameStore.getState().setCorporation(status.corporation ?? undefined)
              } else {
                // Corp member connected — show their name in the activity log
                if (status.source?.method === "join" && status.player?.name) {
                  useGameStore.getState().addActivityLogEntry({
                    type: "join",
                    message: `[${status.player.name}] joined the game`,
                  })
                }

                // Check if this is a fleet/corp ship status update
                const shipId = status.ship?.ship_id ?? getPayloadShipId(status)
                const isCorpShip =
                  isCorporationShipPayload(status) || (shipId && isKnownFleetShip(shipId))

                if (isCorpShip && shipId) {
                  console.debug(
                    `%c[GAME EVENT] Applying ${e.event} to fleet ship ${shipId}`,
                    "color: #fff; background: #336",
                    status.ship
                  )
                  const shipUpdate: Partial<ShipSelf> & { ship_id: string } = {
                    ...status.ship,
                    ship_id: shipId,
                  }
                  const sectorId = getPayloadSectorId(status)
                  if (typeof sectorId === "number") {
                    shipUpdate.sector = sectorId
                  }
                  upsertCorporationShip(shipId, shipUpdate)
                } else {
                  logIgnored(e.event, `player ${status.player.id}`, status)
                }
              }

              break
            }

            // ----- CHARACTERS / NPCS
            case "character.moved": {
              console.debug("[GAME EVENT] Character moved", e.payload)
              const data = e.payload as Msg.CharacterMovedMessage

              const sectorId = typeof data.sector === "number" ? data.sector : data.sector?.id
              const currentSectorId = useGameStore.getState().sector?.id
              const isLocalSector =
                typeof sectorId === "number" &&
                typeof currentSectorId === "number" &&
                sectorId === currentSectorId

              const eventPlayerId = getPayloadPlayerId(data)
              const isLocalPlayer =
                !!eventPlayerId && eventPlayerId === useGameStore.getState().playerSessionId

              if (isLocalSector && !isLocalPlayer) {
                const displayName =
                  data.player?.player_type === "corporation_ship" && data.ship?.ship_name ?
                    data.ship.ship_name
                  : data.player.name
                if (data.movement === "arrive") {
                  console.debug("[GAME EVENT] Adding player to sector", e.payload)
                  const sectorPlayer: Player = {
                    ...data.player,
                    ship: data.player.ship ?? data.ship,
                  }
                  useGameStore.getState().addSectorPlayer(sectorPlayer)
                  useGameStore.getState().addActivityLogEntry({
                    type: "character.moved",
                    message: `[${displayName}] arrived in sector`,
                    meta: {
                      player: data.player,
                      ship: data.ship,
                      sector: data.sector,
                      direction: "arrive",
                      silent: true,
                    },
                  })
                } else if (data.movement === "depart") {
                  console.debug("[GAME EVENT] Removing player from sector", e.payload)
                  useGameStore.getState().removeSectorPlayer(data.player)
                  useGameStore.getState().addActivityLogEntry({
                    type: "character.moved",
                    message: `[${displayName}] departed from sector`,
                    meta: {
                      player: data.player,
                      ship: data.ship,
                      sector: data.sector,
                      direction: "depart",
                      silent: true,
                    },
                  })
                } else {
                  console.warn("[GAME EVENT] Unknown movement type", data.movement)
                }
              } else if (!isLocalSector) {
                logIgnored("character.moved", "non-local sector", data)
              }

              // Update corp ship position icons regardless of sector visibility
              // Only update ships already in our fleet — not foreign corporation ships
              if (
                data.ship?.ship_id &&
                isKnownFleetShip(data.ship.ship_id) &&
                typeof sectorId === "number"
              ) {
                upsertCorporationShip(data.ship.ship_id, { sector: sectorId })
              }

              break
            }

            // ----- MOVEMENT
            case "movement.start": {
              console.debug("[GAME EVENT] Move started", e.payload)
              const data = e.payload as Msg.MovementStartMessage
              if (!isPlayerSessionPayload("movement.start", data)) {
                break
              }

              // Store a reference to the sector to be moved to
              // We don't update client to reference the new sector yet
              // to support animation sequencing and debouncing (task-based movement)
              const newSector = data.sector
              useGameStore.getState().setSectorBuffer(newSector)

              console.debug("[GAME] Starting movement action", newSector)

              useGameStore.getState().setUIState("moving")

              break
            }

            case "movement.complete": {
              console.debug("[GAME EVENT] Move completed", e.payload)
              const data = e.payload as Msg.MovementCompleteMessage
              const isPersonalMove = isPlayerSessionPayload("movement.complete", data)
              if (!isPersonalMove) {
                if (!isCorporationShipPayload(data)) {
                  break
                }

                const shipId = getPayloadShipId(data)
                if (!shipId) {
                  console.warn(
                    "[GAME EVENT] movement.complete missing ship_id for corporation ship",
                    data
                  )
                  break
                }

                const sectorId = getPayloadSectorId(data)
                const shipUpdate: Partial<ShipSelf> = { ...data.ship }
                if (typeof sectorId === "number") {
                  shipUpdate.sector = sectorId
                }
                upsertCorporationShip(shipId, shipUpdate)
                break
              }

              // Update ship and player
              // This hydrates things like warp power, player last active, etc.
              useGameStore.getState().setState({
                ship: data.ship,
                player: data.player,
              })

              // Add entry to movement history
              useGameStore.getState().addMovementHistory({
                from: useGameStore.getState().sector?.id ?? 0,
                to: useGameStore.getState().sectorBuffer?.id ?? 0,
                port: !!useGameStore.getState().sectorBuffer?.port,
                last_visited: data.first_visit ? undefined : new Date().toISOString(),
              })

              // Update activity log
              if (data.first_visit) {
                useGameStore.getState().addActivityLogEntry({
                  type: "map.sector.discovered",
                  message: `Discovered [sector ${useGameStore.getState().sectorBuffer?.id}]`,
                })
              }

              // Swap in the buffered sector
              // Note: Starfield instance already in sync through animation sequencing
              if (useGameStore.getState().sectorBuffer) {
                useGameStore.getState().setSector(useGameStore.getState().sectorBuffer as Sector)
              }

              useGameStore.getState().setUIState("idle")

              // Clear course plot if we've reached the destination or deviated from the path
              const newSectorId = useGameStore.getState().sectorBuffer?.id ?? 0
              if (useGameStore.getState().course_plot?.to_sector === newSectorId) {
                console.debug("[GAME EVENT] Reached intended destination, clearing course plot")
                useGameStore.getState().clearCoursePlot()
              } else if (
                hasDeviatedFromCoursePlot(useGameStore.getState().course_plot, newSectorId)
              ) {
                console.debug("[GAME EVENT] Went to a sector outside of the plot, clearing")
                useGameStore.getState().clearCoursePlot()
              }

              break
            }

            case "bank.transaction": {
              console.debug("[GAME EVENT] Bank transaction", e.payload)
              const data = e.payload as Msg.BankTransactionMessage
              const payloadPlayerId = getPayloadPlayerId(data)
              const bankCharacterId = data.character_id
              const isPersonalBank =
                !!playerSessionId &&
                ((payloadPlayerId && payloadPlayerId === playerSessionId) ||
                  (!payloadPlayerId && bankCharacterId === playerSessionId))

              if (!isPersonalBank) {
                if (!payloadPlayerId && !bankCharacterId) {
                  logMissingPlayerId("bank.transaction", data)
                } else if (payloadPlayerId) {
                  logIgnored("bank.transaction", `player ${payloadPlayerId}`, data)
                } else {
                  logIgnored("bank.transaction", `character ${bankCharacterId ?? "unknown"}`, data)
                }
                break
              }

              // Check if this is a fleet (corp) ship transaction, following
              // the same pattern as credits.transfer
              const bankShipId = getPayloadShipId(data)
              if (bankShipId && isKnownFleetShip(bankShipId)) {
                // Corp ship: update corp ship credits only. Bank balance
                // will be updated by the subsequent status.update event.
                upsertCorporationShip(bankShipId, { credits: data.credits_on_hand_after })
              } else {
                // Personal ship: update ship credits and bank balance
                useGameStore.getState().setShip({ credits: data.credits_on_hand_after })
                const currentPlayer = useGameStore.getState().player
                if (currentPlayer) {
                  useGameStore.getState().setState({
                    player: {
                      ...currentPlayer,
                      credits_in_bank: data.credits_in_bank_after,
                    },
                  })
                }
              }

              if (data.direction === "deposit") {
                useGameStore.getState().addActivityLogEntry({
                  type: "bank.transaction",
                  message: `Deposited [${data.amount}] credits to bank`,
                })
              } else {
                useGameStore.getState().addActivityLogEntry({
                  type: "bank.transaction",
                  message: `Withdrew [${data.amount}] credits from bank`,
                })
              }

              useGameStore.getState().addToast({
                type: "bank.transaction",
                meta: {
                  direction: data.direction,
                  amount: data.amount,
                  credits_on_hand_before: data.credits_on_hand_before,
                  credits_on_hand_after: data.credits_on_hand_after,
                  credits_in_bank_before: data.credits_in_bank_before,
                  credits_in_bank_after: data.credits_in_bank_after,
                },
              })
              break
            }

            // ----- CORPORATION

            case "corporation.created": {
              console.debug("[GAME EVENT] Corporation created", e.payload)
              const data = e.payload as Msg.CorporationCreatedMessage
              useGameStore.getState().setCorporation(data)

              useGameStore.getState().addToast({
                type: "corporation.created",
                meta: {
                  corporation: {
                    corp_id: data.corp_id,
                    name: data.name,
                  } as Corporation,
                },
              })
              break
            }

            case "corporation.disbanded": {
              console.debug("[GAME EVENT] Corporation disbanded", e.payload)
              //const data = e.payload as CorporationDisbandedMessage
              useGameStore.getState().setCorporation(undefined)
              break
            }

            case "corporation.kick_pending": {
              // Character-scoped event — only the kicker (this player)
              // receives it. Opens a destructive confirmation modal.
              // KickConfirmDialog sends confirm-kick / cancel-kick back
              // to the bot based on the user's choice.
              console.debug("[GAME EVENT] Corporation kick pending", e.payload)
              const data = e.payload as {
                corp_id: string
                corp_name: string
                target_id: string
                target_name: string
              }
              useGameStore.getState().setActiveModal("confirm_kick", {
                target_id: data.target_id,
                target_name: data.target_name,
                corp_id: data.corp_id,
                corp_name: data.corp_name,
              } satisfies ConfirmKickData)
              break
            }

            case "corporation.leave_pending": {
              // Character-scoped event — only the leaving player receives
              // it. Emitted by both corporation_leave (explicit leave) and
              // corporation_join (leave-to-join). The modal adapts its copy
              // based on the payload fields.
              console.debug("[GAME EVENT] Corporation leave pending", e.payload)
              const data = e.payload as {
                corp_name: string
                is_founder: boolean
                will_disband: boolean
                member_count: number
                joining_corp_id?: string
                joining_corp_name?: string
                joining_invite_code?: string
              }
              useGameStore.getState().setActiveModal("confirm_leave", {
                corp_name: data.corp_name,
                is_founder: data.is_founder,
                will_disband: data.will_disband,
                member_count: data.member_count,
                joining_corp_id: data.joining_corp_id,
                joining_corp_name: data.joining_corp_name,
                joining_invite_code: data.joining_invite_code,
              } satisfies ConfirmLeaveData)
              break
            }

            case "confirmation.resolved": {
              console.debug("[GAME EVENT] Confirmation resolved", e.payload)
              // Dismiss any open confirmation modal. Sent by the bot after
              // processing confirm-leave / cancel-leave / confirm-kick /
              // cancel-kick client messages.
              const modal = useGameStore.getState().activeModal?.modal
              console.debug("[GAME EVENT] Active modal at resolution:", modal)
              if (modal === "confirm_leave" || modal === "confirm_kick") {
                useGameStore.getState().setActiveModal(undefined)
              }
              break
            }

            case "corporation.invite_code_regenerated": {
              // Corp-scoped event. Optimistically patch the invite code in
              // the local store so the open CorporationDetailsDialog updates
              // immediately, then fetch the full corp payload so
              // `invite_code_generated` / `invite_code_generated_by` come
              // along too. Non-founders will simply get the full refresh.
              console.debug("[GAME EVENT] Corporation invite code regenerated", e.payload)
              const data = e.payload as { new_invite_code?: string }
              const corp = useGameStore.getState().corporation
              if (corp && typeof data.new_invite_code === "string") {
                useGameStore.getState().setCorporation({
                  ...corp,
                  invite_code: data.new_invite_code,
                })
              }
              break
            }

            case "corporation.member_joined": {
              // Emitted corp-scoped when any member joins (including self).
              console.debug("[GAME EVENT] Corporation member joined", e.payload)
              const data = e.payload as {
                corp_id: string
                name: string
                member_name: string
                member_count: number
                actor_character_id?: string
              }
              const myId = useGameStore.getState().character_id
              const isSelf = Boolean(
                data.actor_character_id && myId && data.actor_character_id === myId
              )
              useGameStore.getState().addToast({
                type: "corporation.member_joined",
                meta: {
                  corp_name: data.name,
                  member_name: data.member_name,
                  member_count: data.member_count,
                  is_self: isSelf,
                },
              })
              break
            }

            case "corporation.member_left": {
              // Emitted corp-scoped when a member leaves voluntarily or
              // is kicked silently via auto-leave. The edge function
              // emits status.update + map data to affected clients
              // directly — no client-side dispatch needed.
              console.debug("[GAME EVENT] Corporation member left", e.payload)
              break
            }

            case "corporation.member_kicked": {
              // Emitted corp-scoped on confirmed kick. The kicked member
              // gets their own state reset via corporation.data from the
              // edge function. Remaining members receive status.update
              // directly — no client-side dispatch needed.
              console.debug("[GAME EVENT] Corporation member kicked", e.payload)
              break
            }

            case "corporation.data": {
              console.debug("[GAME EVENT] Corporation data", e.payload)
              const data = e.payload as { corporation: Corporation | null }
              const prevCorp = useGameStore.getState().corporation
              const wasCorp = !!prevCorp
              useGameStore.getState().setCorporation(data.corporation ?? undefined)

              // Sync fleet ships from the corporation payload so the
              // PlayerShipsPanel sees them immediately (join) or drops them
              // (leave/kick, handled by setCorporation stripping corp ships).
              if (data.corporation?.ships) {
                for (const ship of data.corporation.ships) {
                  upsertCorporationShip(ship.ship_id, {
                    ship_id: ship.ship_id,
                    ship_name: ship.name,
                    ship_type: ship.ship_type,
                    sector: ship.sector ?? undefined,
                    owner_type: "corporation",
                    credits: ship.credits,
                    cargo: ship.cargo,
                    cargo_capacity: ship.cargo_capacity,
                    warp_power: ship.warp_power,
                    warp_power_capacity: ship.warp_power_capacity,
                    shields: ship.shields,
                    max_shields: ship.max_shields,
                    fighters: ship.fighters,
                    max_fighters: ship.max_fighters,
                    current_task_id: ship.current_task_id,
                  })
                }
              }

              // Left/kicked from a corp — show toast. Map invalidation is
              // handled by setCorporation detecting the corp transition.
              if (wasCorp && !data.corporation) {
                // Dismiss any corp confirmation modal (covers the voice-
                // confirm path where the UI button wasn't clicked).
                const modal = useGameStore.getState().activeModal?.modal
                if (modal === "confirm_leave" || modal === "confirm_kick") {
                  useGameStore.getState().setActiveModal(undefined)
                }
                useGameStore.getState().addToast({
                  type: "corporation.left",
                  meta: { corp_name: prevCorp?.name ?? "Corporation" },
                })
              }
              useGameStore.getState().resolveFetchPromise("get-my-corporation")
              break
            }

            case "corporation_info": {
              console.debug("[GAME EVENT] Corporation info", e.payload)
              const data = e.payload as Msg.CorporationInfoMessage
              const corpData = data.result?.corporation
              if (!corpData) {
                break
              }

              // Update corporation data (including destroyed_ships)
              useGameStore.getState().setCorporation(corpData)

              // Update fleet ships
              for (const ship of corpData.ships) {
                upsertCorporationShip(ship.ship_id, {
                  ship_id: ship.ship_id,
                  ship_name: ship.name,
                  ship_type: ship.ship_type,
                  sector: ship.sector ?? undefined,
                  owner_type: "corporation",
                  credits: ship.credits,
                  cargo: ship.cargo,
                  cargo_capacity: ship.cargo_capacity,
                  warp_power: ship.warp_power,
                  warp_power_capacity: ship.warp_power_capacity,
                  shields: ship.shields,
                  max_shields: ship.max_shields,
                  fighters: ship.fighters,
                  max_fighters: ship.max_fighters,
                  current_task_id: ship.current_task_id,
                })
              }

              useGameStore.getState().resolveFetchPromise("get-my-corporation")
              break
            }

            case "corporation.ship_purchased": {
              console.debug("[GAME EVENT] Ship purchased", e.payload)
              const data = e.payload as Msg.CorporationShipPurchaseMessage
              useGameStore.getState().addShip({
                ship_id: data.ship_id,
                ship_name: data.ship_name,
                ship_type: data.ship_type,
                owner_type: "corporation",
                sector: data.sector,
              })
              useGameStore.getState().addToast({
                type: "ship.purchased",
                meta: {
                  ship: {
                    ship_id: data.ship_id,
                    ship_name: data.ship_name,
                    ship_type: data.ship_type,
                  },
                },
              })
              break
            }

            case "corporation.ship_sold": {
              console.debug("[GAME EVENT] Ship sold", e.payload)
              const data = e.payload as Msg.CorporationShipSoldMessage
              useGameStore.getState().removeShip(data.ship_id)
              useGameStore.getState().addToast({
                type: "ship.sold",
                meta: {
                  ship: {
                    ship_id: data.ship_id,
                    ship_name: data.ship_name,
                    ship_type: data.ship_type,
                  },
                  trade_in_value: data.trade_in_value,
                },
              })
              break
            }

            case "ship.definitions": {
              console.debug("[GAME EVENT] Ship definitions", e.payload)
              const data = e.payload as { definitions: ShipDefinition[] }
              if (Array.isArray(data.definitions)) {
                useGameStore.getState().setShipDefinitions(data.definitions)
              }
              useGameStore.getState().resolveFetchPromise("get-ship-definitions")
              break
            }

            // ----- MAP

            case "sector.update": {
              console.debug("[GAME EVENT] Sector update", e.payload)
              const data = e.payload as Msg.SectorUpdateMessage

              if (useGameStore.getState().sector?.id !== data.id) {
                logIgnored("sector.update", "non-current sector", data)
                break
              }
              useGameStore.getState().updateSector(data as Sector)

              // Propagate garrison changes to map data so sector nodes re-render
              const sectorData = data as Sector
              const mapGarrison =
                sectorData.garrison ?
                  {
                    player_id: sectorData.garrison.owner_id,
                    corporation_id: null as string | null,
                  }
                : null
              useGameStore.getState().updateMapSectors([{ id: data.id, garrison: mapGarrison }])

              // Note: not updating activity log as redundant from other logs

              //useGameStore.getState().addActivityLogEntry({
              //  type: "sector.update",
              //  message: `Sector ${data.id} updated`,
              //});

              break
            }

            case "salvage.created": {
              console.debug("[GAME EVENT] Salvage created", e.payload)
              const data = e.payload as Msg.SalvageCreatedMessage
              const salvagePlayerId = getPayloadPlayerId(data)
              if (salvagePlayerId) {
                if (!isPlayerSessionPayload("salvage.created", data)) {
                  break
                }
              } else {
                const sectorId = data.sector?.id
                if (!sectorId || sectorId !== useGameStore.getState().sector?.id) {
                  logIgnored("salvage.created", "non-current sector", data)
                  break
                }
              }

              // Note: we update sector contents in proceeding sector.update event

              // @TODO: status update is missing, so we may need to update player state here
              const salvageDetails: Salvage | undefined =
                data.salvage_details ??
                (data.salvage_id ?
                  {
                    salvage_id: data.salvage_id,
                    source:
                      data.from_ship_name || data.from_ship_type ?
                        {
                          ship_name: data.from_ship_name ?? "Unknown",
                          ship_type: data.from_ship_type ?? "unknown",
                        }
                      : undefined,
                    cargo: data.cargo,
                    scrap: data.scrap,
                    credits: data.credits,
                    created_at: data.timestamp,
                  }
                : undefined)

              useGameStore.getState().addActivityLogEntry({
                type: "salvage.created",
                message: `Salvage created in [sector ${
                  data.sector.id
                }] ${salvageCreatedSummaryString(salvageDetails ?? {})}`,
              })

              if (salvageDetails) {
                useGameStore.getState().addToast({
                  type: "salvage.created",
                  meta: {
                    salvage: salvageDetails,
                  },
                })
              }
              break
            }

            case "salvage.collected": {
              console.debug("[GAME EVENT] Salvage claimed", e.payload)
              const data = e.payload as Msg.SalvageCollectedMessage
              if (!isPlayerSessionPayload("salvage.collected", data)) {
                break
              }

              useGameStore.getState().addActivityLogEntry({
                type: "salvage.collected",
                message: `Salvage collected in [sector ${
                  data.sector.id
                }] ${salvageCollectedSummaryString(data.salvage_details)}`,
              })

              useGameStore.getState().addToast({
                type: "salvage.collected",
                meta: {
                  salvage: data.salvage_details as Salvage,
                },
              })
              break
            }

            case "path.region":
            case "course.plot": {
              console.debug("[GAME EVENT] Course plot", e.payload)
              const data = e.payload as Msg.CoursePlotMessage
              if (!isPlayerSessionPayload(e.event, data)) {
                break
              }

              useGameStore.getState().setCoursePlot(data)
              break
            }

            case "map.region": {
              console.debug("[GAME EVENT] Regional map data", e.payload)
              if (!isPlayerSessionPayload("map.region", e.payload as Msg.ServerMessagePayload)) {
                break
              }

              const regionData = e.payload as Msg.MapLocalMessage
              useGameStore.getState().setRegionalMapData(regionData.sectors)

              // If the server included fit_sectors, trigger fit (unless already pending)
              if (Array.isArray(regionData.fit_sectors) && regionData.fit_sectors.length > 0) {
                const fitSectors = regionData.fit_sectors.filter(
                  (id): id is number => typeof id === "number" && Number.isFinite(id)
                )
                if (fitSectors.length > 0) {
                  useGameStore.getState().fitMapToSectors(fitSectors)
                }
              }
              break
            }

            case "map.local": {
              console.debug("[GAME EVENT] Local map data", e.payload)
              if (!isPlayerSessionPayload("map.local", e.payload as Msg.ServerMessagePayload)) {
                break
              }

              useGameStore.getState().setLocalMapData((e.payload as Msg.MapLocalMessage).sectors)
              break
            }

            case "map.update": {
              console.debug("[GAME EVENT] Map update", e.payload)
              const data = e.payload as Msg.MapLocalMessage
              useGameStore.getState().updateMapSectors(data.sectors as MapSectorNode[])
              break
            }

            // ----- TRADING & COMMERCE

            case "trade.executed": {
              console.debug("[GAME EVENT] Trade executed", e.payload)
              const data = e.payload as Msg.TradeExecutedMessage
              if (!isPlayerSessionPayload("trade.executed", data)) {
                break
              }

              /*useGameStore.getState().addActivityLogEntry({
                type: "trade.executed",
                message: `Trade executed: ${
                  data.trade.trade_type === "buy" ? "Bought" : "Sold"
                } ${data.trade.units} [${
                  RESOURCE_SHORT_NAMES[data.trade.commodity]
                }] for [CR ${data.trade.total_price}]`,
              })*/

              useGameStore.getState().addTradeHistoryEntry({
                sector: useGameStore.getState().sector?.id ?? 0,
                commodity: data.trade.commodity,
                units: data.trade.units,
                price_per_unit: data.trade.price_per_unit,
                total_price: data.trade.total_price,
                is_buy: data.trade.trade_type === "buy",
              })

              useGameStore.getState().addToast({
                type: "trade.executed",
                meta: {
                  ...data.trade,
                  old_credits: useGameStore.getState().ship?.credits ?? 0,
                },
              })
              break
            }

            case "port.update": {
              console.debug("[GAME EVENT] Port update", e.payload)
              const data = e.payload as Msg.PortUpdateMessage

              // If update is for current sector, update port payload
              useGameStore.getState().updateSector(data.sector)
              break
            }

            case "ports.list": {
              console.debug("[GAME EVENT] Port list", e.payload)
              // @TODO: implement - waiting on shape of event to align to schema
              const data = e.payload as Msg.KnownPortListMessage
              useGameStore.getState().setKnownPorts(data.ports)
              break
            }

            case "warp.purchase": {
              console.debug("[GAME EVENT] Warp purchase", e.payload)
              const data = e.payload as Msg.WarpPurchaseMessage
              if (!isPlayerSessionPayload("warp.purchase", data)) {
                break
              }

              // Largely a noop as status.update is dispatched immediately after
              // warp purchase. We just update activity log here for now.

              useGameStore.getState().addActivityLogEntry({
                type: "warp.purchase",
                message: `Purchased [${data.units}] warp units for [${data.total_cost}] credits`,
              })

              useGameStore.getState().addToast({
                type: "warp.purchase",
                meta: {
                  prev_amount: useGameStore.getState().ship?.warp_power ?? 0,
                  new_amount: data.new_warp_power,
                  capacity: data.warp_power_capacity,
                  cost: data.total_cost,
                  new_credits: data.new_credits,
                  prev_credits: useGameStore.getState().ship?.credits ?? 0,
                },
              })
              break
            }

            case "fighter.purchase": {
              console.debug("[GAME EVENT] Fighter purchase", e.payload)
              // Noop — status.update is dispatched immediately after fighter purchase
              break
            }

            case "warp.transfer":
            case "credits.transfer": {
              const eventType = e.event as "warp.transfer" | "credits.transfer"
              const transferType = eventType === "warp.transfer" ? "Warp" : "Credits"

              console.debug(`[GAME EVENT] ${transferType} transfer`, e.payload)

              const data = e.payload as Msg.WarpTransferMessage | Msg.CreditsTransferMessage
              const payloadPlayerId = getPayloadPlayerId(data)
              const fromId = data.from?.id
              const toId = data.to?.id
              const isPersonalTransfer =
                !!playerSessionId &&
                ((payloadPlayerId && payloadPlayerId === playerSessionId) ||
                  (!payloadPlayerId &&
                    ((fromId && fromId === playerSessionId) || (toId && toId === playerSessionId))))
              if (!isPersonalTransfer) {
                if (!payloadPlayerId && !fromId && !toId) {
                  logMissingPlayerId(eventType, data)
                } else if (payloadPlayerId) {
                  logIgnored(eventType, `player ${payloadPlayerId}`, data)
                } else {
                  logIgnored(
                    eventType,
                    `transfer ${fromId ?? "unknown"} -> ${toId ?? "unknown"}`,
                    data
                  )
                }
                break
              }

              // Update player ship and corp ship balances
              if (eventType === "credits.transfer") {
                const creditsData = data as Msg.CreditsTransferMessage
                const amount = creditsData.transfer_details.credits
                const currentShipCredits = useGameStore.getState().ship?.credits ?? 0

                if (data.transfer_direction === "sent") {
                  useGameStore.getState().setShip({ credits: currentShipCredits - amount })
                  const toShipId = data.to?.ship?.ship_id
                  if (toShipId && isKnownFleetShip(toShipId)) {
                    const corpShip = (useGameStore.getState().ships.data ?? []).find(
                      (s) => s.ship_id === toShipId
                    )
                    upsertCorporationShip(toShipId, {
                      credits: (corpShip?.credits ?? 0) + amount,
                    })
                  }
                } else {
                  useGameStore.getState().setShip({ credits: currentShipCredits + amount })
                  const fromShipId = data.from?.ship?.ship_id
                  if (fromShipId && isKnownFleetShip(fromShipId)) {
                    const corpShip = (useGameStore.getState().ships.data ?? []).find(
                      (s) => s.ship_id === fromShipId
                    )
                    upsertCorporationShip(fromShipId, {
                      credits: Math.max(0, (corpShip?.credits ?? 0) - amount),
                    })
                  }
                }
              } else if (eventType === "warp.transfer") {
                const warpData = data as Msg.WarpTransferMessage
                const amount = warpData.transfer_details.warp_power
                const currentWarp = useGameStore.getState().ship?.warp_power ?? 0

                if (data.transfer_direction === "sent") {
                  useGameStore.getState().setShip({ warp_power: currentWarp - amount })
                  const toShipId = data.to?.ship?.ship_id
                  if (toShipId && isKnownFleetShip(toShipId)) {
                    const corpShip = (useGameStore.getState().ships.data ?? []).find(
                      (s) => s.ship_id === toShipId
                    )
                    upsertCorporationShip(toShipId, {
                      warp_power: (corpShip?.warp_power ?? 0) + amount,
                    })
                  }
                } else {
                  useGameStore.getState().setShip({ warp_power: currentWarp + amount })
                  const fromShipId = data.from?.ship?.ship_id
                  if (fromShipId && isKnownFleetShip(fromShipId)) {
                    const corpShip = (useGameStore.getState().ships.data ?? []).find(
                      (s) => s.ship_id === fromShipId
                    )
                    upsertCorporationShip(fromShipId, {
                      warp_power: Math.max(0, (corpShip?.warp_power ?? 0) - amount),
                    })
                  }
                }
              }

              if (data.transfer_direction === "received") {
                useGameStore.getState().triggerAlert("transfer")
              }

              useGameStore.getState().addActivityLogEntry({
                type: eventType,
                message: transferSummaryString(data),
              })

              useGameStore.getState().addToast({
                type: "transfer",
                meta: {
                  direction: data.transfer_direction,
                  from: data.from,
                  to: data.to,
                  transfer_details: data.transfer_details,
                },
              })

              break
            }

            // ----- COMBAT

            case "combat.round_waiting": {
              console.debug("[GAME EVENT] Combat round waiting", e.payload)
              const data = e.payload as Msg.CombatRoundWaitingMessage

              // Mark sector as in-combat for the map overlay regardless of
              // whether we are a participant — observed-combat flavors land
              // here too and should still highlight the sector.
              const overlaySectorId = getPayloadSectorId(data)
              if (typeof data.combat_id === "string" && typeof overlaySectorId === "number") {
                useGameStore.getState().addCombatSector(data.combat_id, overlaySectorId)
              }

              if (!playerSessionId) {
                logIgnored("combat.round_waiting", "personalPlayerId not set", data)
                break
              }
              const isParticipant = data.participants?.some(
                (participant) => participant.id === playerSessionId
              )
              if (!isParticipant) {
                logIgnored("combat.round_waiting", "not a participant", data)
                break
              }

              applyCombatRoundWaitingState(useGameStore.getState(), data as CombatSession)
              break
            }

            case "combat.round_resolved": {
              console.debug("[GAME EVENT] Combat round resolved", e.payload)
              const data = e.payload as Msg.CombatRoundResolvedMessage
              const activeCombatId = useGameStore.getState().activeCombatSession?.combat_id
              const hasPersonalAction =
                !!playerSessionId &&
                !!data.actions &&
                Object.prototype.hasOwnProperty.call(data.actions, playerSessionId)
              if (!hasPersonalAction && data.combat_id !== activeCombatId) {
                logIgnored("combat.round_resolved", "not part of combat", data)
                break
              }
              applyCombatRoundResolvedState(useGameStore.getState(), data as CombatRound)
              break
            }

            case "combat.action_accepted":
            case "combat.action_response": {
              console.debug("[GAME EVENT] Combat action response", e.payload)
              const data = e.payload as Msg.CombatActionAcceptedMessage
              const payloadPlayerId = getPayloadPlayerId(data)
              const activeCombatId = useGameStore.getState().activeCombatSession?.combat_id
              const isPersonalAction =
                !!playerSessionId &&
                ((payloadPlayerId && payloadPlayerId === playerSessionId) ||
                  (!payloadPlayerId && data.combat_id === activeCombatId))
              if (!isPersonalAction) {
                if (payloadPlayerId) {
                  logIgnored("combat.action_response", `player ${payloadPlayerId}`, data)
                } else {
                  logIgnored("combat.action_response", "not active combat", data)
                }
                break
              }

              applyCombatActionAcceptedState(useGameStore.getState(), data as CombatActionReceipt)
              break
            }

            case "combat.ended": {
              console.debug("[GAME EVENT] Combat ended", e.payload)
              const data = e.payload as Msg.CombatEndedMessage

              // Always clear the map overlay entry — fires for participant
              // and observer (observed: true) flavors alike.
              if (typeof data.combat_id === "string") {
                useGameStore.getState().removeCombatSector(data.combat_id)
              }

              const activeCombatId = useGameStore.getState().activeCombatSession?.combat_id
              const hasPersonalAction =
                !!playerSessionId &&
                !!data.actions &&
                Object.prototype.hasOwnProperty.call(data.actions, playerSessionId)
              if (!hasPersonalAction && data.combat_id !== activeCombatId) {
                logIgnored("combat.ended", "not part of combat", data)
                break
              }

              applyCombatEndedState(useGameStore.getState(), data as CombatEndedRound)
              break
            }

            case "ship.renamed":
            case "ship.rename": {
              console.debug("[GAME EVENT] Ship renamed", e.payload)
              const data = e.payload as Msg.ShipRenameMessage
              // Update in the ships list (corporation/fleet ships)
              useGameStore.getState().updateShip({
                ship_id: data.ship_id,
                ship_name: data.ship_name,
              })
              // Update the active ship if it's the one being renamed
              if (useGameStore.getState().ship?.ship_id === data.ship_id) {
                useGameStore.getState().setShip({ ship_name: data.ship_name })
              }
              break
            }

            case "ship.destroyed": {
              console.debug("[GAME EVENT] Ship destroyed", e.payload)
              applyShipDestroyedState(
                useGameStore.getState(),
                e.payload as Msg.ShipDestroyedMessage
              )
              break
            }

            // ----- TASKS

            case "task.start": {
              console.debug("[GAME EVENT] Task start", e.payload)
              const data = e.payload as Msg.TaskStartMessage

              const taskId = normalizeTaskId(data.task_id)
              const myId = useGameStore.getState().character_id
              const isMyTask = !data.actor_character_id || data.actor_character_id === myId

              // Only track tasks initiated by this player in the task engine.
              // Other corp members' tasks show ship "busy" status via the
              // ship's current_task_id but don't fill our task engine badges.
              if (taskId && isMyTask) {
                useGameStore.getState().addActiveTask({
                  task_id: taskId,
                  task_description: data.task_description,
                  started_at: data.source?.timestamp || new Date().toISOString(),
                  actor_character_id: data.actor_character_id,
                  actor_character_name: data.actor_character_name,
                  task_scope: data.task_scope,
                  ship_id: data.ship_id,
                  ship_name: data.ship_name,
                  ship_type: data.ship_type,
                })
              }

              // Update corp ship's task state so ShipCard shows busy status
              if (taskId && data.ship_id && isKnownFleetShip(data.ship_id)) {
                upsertCorporationShip(data.ship_id, {
                  current_task_id: taskId,
                  current_task_actor_name: data.actor_character_name ?? null,
                })
              }
              break
            }

            case "task.finish": {
              console.debug("[GAME EVENT] Task finish", e.payload)
              const data = e.payload as Msg.TaskFinishMessage

              const taskId = normalizeTaskId(data.task_id)

              // Clear corp ship's task state regardless of who owns the task
              if (data.ship_id && isKnownFleetShip(data.ship_id)) {
                upsertCorporationShip(data.ship_id, {
                  current_task_id: null,
                  current_task_actor_name: null,
                })
              }

              // Only process task engine cleanup if this task is in our
              // active tasks (i.e. we tracked it on task.start because it
              // belongs to us).
              if (taskId && useGameStore.getState().activeTasks[taskId]) {
                useGameStore.getState().removeActiveTask(taskId)

                // Backward compatibility while old short IDs may still exist in local state.
                if (taskId.length > 6) {
                  useGameStore.getState().removeActiveTask(taskId.slice(0, 6))
                } else {
                  const activeTaskIds = Object.keys(useGameStore.getState().activeTasks)
                  for (const activeTaskId of activeTaskIds) {
                    if (activeTaskId.startsWith(taskId)) {
                      useGameStore.getState().removeActiveTask(activeTaskId)
                    }
                  }
                }

                // Add task summary to store
                useGameStore.getState().addTaskSummary(data as unknown as TaskSummary)

                // Refetch task history
                useGameStore
                  .getState()
                  .dispatchAction({ type: "get-task-history", payload: { max_rows: 20 } })
              }
              break
            }

            case "task_output": {
              console.debug("[GAME EVENT] Task output", e, e.payload)
              const data = e.payload as Msg.TaskOutputMessage
              const taskIdCandidates = getTaskIdCandidates(e, data)
              if (taskIdCandidates.length === 0) {
                console.warn("[GAME EVENT] Task output missing task_id", e.payload)
                return
              }

              const activeTasks = useGameStore.getState().activeTasks
              const activeTaskId = taskIdCandidates.find((candidate) =>
                Object.prototype.hasOwnProperty.call(activeTasks, candidate)
              )
              const prefixedActiveTaskId = taskIdCandidates
                .filter((candidate) => candidate.length === 6)
                .map((candidate) =>
                  Object.keys(activeTasks).find((activeTaskId) =>
                    activeTaskId.startsWith(candidate)
                  )
                )
                .find((taskId): taskId is string => !!taskId)

              // Only process output for tasks we're tracking (our own tasks).
              const selectedTaskId = activeTaskId ?? prefixedActiveTaskId
              if (!selectedTaskId) break

              useGameStore.getState().addTaskOutput({
                task_id: selectedTaskId,
                text: data.text,
                task_message_type: data.task_message_type,
              })
              break
            }

            case "task_complete": {
              console.debug("[GAME EVENT] Task complete", e.payload)
              const data = e.payload as Msg.TaskCompleteMessage

              useGameStore.getState().addActivityLogEntry({
                type: "task.complete",
                message: `${data.was_cancelled ? "Task cancelled" : "Task completed"}`,
              })

              //@TODO Properly handle task failures
              if (data.was_cancelled) {
                useGameStore.getState().setTaskWasCancelled(true)
              }
              break
            }

            // ----- COMBAT (SUPPLEMENTAL)

            case "garrison.deployed": {
              console.debug("[GAME EVENT] Garrison deployed", e.payload)
              const data = e.payload as Msg.GarrisonDeployedMessage

              const deployShipId = getPayloadShipId(data)
              if (useGameStore.getState().ship?.ship_id === deployShipId) {
                useGameStore.getState().setShip({ fighters: data.fighters_remaining })
              } else if (isCorporationShipPayload(data) && deployShipId) {
                upsertCorporationShip(deployShipId, { fighters: data.fighters_remaining })
              }

              useGameStore.getState().addActivityLogEntry({
                type: "garrison.deployed",
                message: `Garrison deployed in [sector ${data.sector.id}] with [${data.garrison.fighters}] fighters`,
              })
              break
            }

            case "garrison.collected": {
              console.debug("[GAME EVENT] Garrison collected", e.payload)
              const data = e.payload as Msg.GarrisonCollectedMessage

              const collectShipId = getPayloadShipId(data)
              if (useGameStore.getState().ship?.ship_id === collectShipId) {
                useGameStore.getState().setShip({ fighters: data.fighters_on_ship })
              } else if (isCorporationShipPayload(data) && collectShipId) {
                upsertCorporationShip(collectShipId, { fighters: data.fighters_on_ship })
              }

              useGameStore.getState().addActivityLogEntry({
                type: "garrison.collected",
                message:
                  data.disbanded ?
                    `Garrison disbanded in [sector ${data.sector.id}] - [${data.fighters_disbanded ?? 0}] fighters destroyed`
                  : `Collected fighters from [sector ${data.sector.id}] - ship now has [${data.fighters_on_ship}] fighters`,
              })
              break
            }

            case "garrison.mode_changed": {
              console.debug("[GAME EVENT] Garrison mode changed", e.payload)
              const data = e.payload as Msg.GarrisonModeChangedMessage

              useGameStore.getState().addActivityLogEntry({
                type: "garrison.mode_changed",
                message: `Garrison mode changed to [${data.garrison.mode}] in [sector ${data.sector.id}]`,
              })
              break
            }

            case "garrison.destroyed": {
              console.debug("[GAME EVENT] Garrison destroyed", e.payload)
              const data = e.payload as Msg.GarrisonDestroyedMessage

              useGameStore.getState().updateMapSectors([{ id: data.sector.id, garrison: null }])

              useGameStore.getState().addActivityLogEntry({
                type: "garrison.destroyed",
                message: `Garrison destroyed in [sector ${data.sector.id}] (mode=${data.mode}, owner=${data.owner_name})`,
              })
              break
            }

            case "ships.strategy_set": {
              console.debug("[GAME EVENT] Ship strategy set", e.payload)
              const data = e.payload as {
                ship_id?: string
                ship_name?: string
                strategy?: {
                  strategy_id?: string
                  template?: "balanced" | "offensive" | "defensive"
                  custom_prompt?: string | null
                  doctrine?: string
                  updated_at?: string
                  is_default?: boolean
                }
              }
              if (!data.ship_id || !data.strategy || !data.strategy.template) {
                logIgnored("ships.strategy_set", "missing required fields", data)
                break
              }
              useGameStore.getState().setShipStrategy(data.ship_id, {
                strategy_id: data.strategy.strategy_id,
                ship_id: data.ship_id,
                template: data.strategy.template,
                custom_prompt: data.strategy.custom_prompt ?? null,
                doctrine: data.strategy.doctrine,
                updated_at: data.strategy.updated_at,
                is_default: data.strategy.is_default,
              })
              break
            }

            case "ships.strategy_cleared": {
              console.debug("[GAME EVENT] Ship strategy cleared", e.payload)
              const data = e.payload as { ship_id?: string }
              if (!data.ship_id) {
                logIgnored("ships.strategy_cleared", "missing ship_id", data)
                break
              }
              useGameStore.getState().clearShipStrategy(data.ship_id)
              break
            }

            case "garrison.character_moved": {
              console.debug("[GAME EVENT] Garrison character moved", e.payload)
              const data = e.payload as Msg.GarrisonCharacterMovedMessage
              const sectorId = typeof data.sector === "number" ? data.sector : data.sector?.id
              const currentSector = useGameStore.getState().sector
              const isLocalSector =
                typeof sectorId === "number" &&
                typeof currentSector?.id === "number" &&
                sectorId === currentSector.id

              if (isLocalSector) {
                if (data.movement === "depart") {
                  useGameStore.getState().removeSectorPlayer(data.player)
                } else if (data.movement === "arrive") {
                  useGameStore.getState().addSectorPlayer(data.player)
                }
              }

              useGameStore.getState().addActivityLogEntry({
                type: "garrison.character_moved",
                message: `[${data.player.name}] ${data.movement === "depart" ? "departed" : "arrived"} near garrison`,
              })
              break
            }

            // ----- QUESTS
            case "quest.status": {
              console.debug("[GAME EVENT] Quest status", e.payload)
              const data = e.payload as Msg.QuestStatusMessage
              if (data.quests) {
                useGameStore.getState().setQuests(data.quests)
              }
              break
            }

            case "quest.progress": {
              const data = e.payload as Msg.QuestProgressMessage
              useGameStore
                .getState()
                .updateQuestStepProgress(data.quest_id, data.step_index, data.current_value)
              break
            }

            case "quest.step_completed": {
              console.debug("[GAME EVENT] Quest step completed", e.payload)
              const data = e.payload as Msg.QuestStepCompletedMessage
              useGameStore
                .getState()
                .updateQuestStepCompleted(data.quest_id, data.step_index, data.next_step)
              if (data.next_step) {
                useGameStore.getState().setQuestCompletionData({
                  type: "step",
                  questId: data.quest_id,
                  stepId: data.step_id,
                  questName: data.quest_name,
                  completedStepName: data.step_name,
                  nextStep: data.next_step,
                  reward: data.reward,
                })
                useGameStore.getState().setNotifications({ questCompleted: true })
              }
              useGameStore.getState().addActivityLogEntry({
                type: "quest.step_completed",
                message: `[${data.quest_name}] Step completed: ${data.step_name}`,
              })
              break
            }

            case "quest.completed": {
              console.debug("[GAME EVENT] Quest completed", e.payload)
              const data = e.payload as Msg.QuestCompletedMessage
              useGameStore.getState().setQuestCompletionData({
                type: "quest",
                completedQuestName: data.quest_name,
                snapshotQuestIds: [],
                reward: data.reward,
              })
              useGameStore.getState().completeQuest(data.quest_id)
              useGameStore.getState().setNotifications({ questCompleted: true })
              useGameStore.getState().addActivityLogEntry({
                type: "quest.completed",
                message: `Quest completed: ${data.quest_name}`,
              })
              break
            }

            case "quest.reward_claimed": {
              const data = e.payload as Msg.QuestRewardClaimedMessage
              useGameStore.getState().claimStepReward(data.quest_id, data.step_id)
              if (data.reward.credits) {
                const currentCredits = useGameStore.getState().ship?.credits ?? 0
                useGameStore.getState().setShip({ credits: currentCredits + data.reward.credits })
              }
              useGameStore.getState().addActivityLogEntry({
                type: "quest.reward_claimed",
                message: `[${data.quest_name}] Reward claimed: ${data.step_name} (+${data.reward.credits} credits)`,
              })
              break
            }

            // ----- MISC

            case "chat.message": {
              console.debug("[GAME EVENT] Chat message", e.payload)
              const data = e.payload as Msg.IncomingChatMessage

              useGameStore.getState().addMessage(data as ChatMessage)

              const timestampClient = Date.now()

              if (
                data.type === "direct" &&
                data.from_name &&
                data.from_name !== useGameStore.getState().player?.name
              ) {
                // Show a nofication in the conversation panel
                // @TODO: do not do this if chat window is open
                useGameStore.getState().setNotifications({ newChatMessage: true })

                useGameStore.getState().addActivityLogEntry({
                  type: "chat.direct",
                  message: `New direct message from [${data.from_name}]`,
                  timestamp_client: timestampClient,
                  meta: {
                    from_name: data.from_name,
                    signature_prefix: "chat.direct:",
                    //@TODO: change this to from_id when available
                    signature_keys: [data.from_name],
                  },
                })
              }
              break
            }

            case "error": {
              console.debug("[GAME EVENT] Error", e.payload)
              const data = e.payload as Msg.ErrorMessage

              // Handle map center fallback (e.g. center sector not visited)
              if (data.endpoint === "local_map_region") {
                const errorText = typeof data.error === "string" ? data.error : ""
                if (errorText.includes("Center sector") && errorText.includes("visited")) {
                  useGameStore.getState().handleMapCenterFallback()
                }
              }
              break
            }

            case "ui-action": {
              const uiPayload = e.payload as Record<string, unknown>
              if (uiPayload?.["ui-action"] === "control_ui") {
                console.debug("[GAME EVENT] UI action control_ui", uiPayload)

                // Panel toggling is UI-level, handle in UISlice
                if (typeof uiPayload.show_panel === "string") {
                  useGameStore
                    .getState()
                    .setUIModeFromAgent(uiPayload.show_panel as UIMode | "default")
                }

                // Modal opening from the UI agent (e.g. corporation_details)
                if (typeof uiPayload.show_modal === "string") {
                  useGameStore.getState().setActiveModal(uiPayload.show_modal as UIModal)
                }

                // Switch the player ship panel tab (e.g. ship strategies)
                if (typeof uiPayload.show_player_ship_tab === "string") {
                  useGameStore
                    .getState()
                    .setPlayerShipTabFromAgent(uiPayload.show_player_ship_tab as PlayerShipTab)
                }

                // Everything else is map-domain
                useGameStore.getState().handleMapUIAction({
                  mapCenterSector:
                    (
                      typeof uiPayload.map_center_sector === "number" &&
                      Number.isFinite(uiPayload.map_center_sector)
                    ) ?
                      uiPayload.map_center_sector
                    : undefined,
                  mapZoomLevel:
                    (
                      typeof uiPayload.map_zoom_level === "number" &&
                      Number.isFinite(uiPayload.map_zoom_level)
                    ) ?
                      uiPayload.map_zoom_level
                    : undefined,
                  mapZoomDirection:
                    uiPayload.map_zoom_direction === "in" ? "in"
                    : uiPayload.map_zoom_direction === "out" ? "out"
                    : undefined,
                  highlightPath:
                    Array.isArray(uiPayload.map_highlight_path) ?
                      (uiPayload.map_highlight_path as number[]).filter(
                        (v) => typeof v === "number" && Number.isFinite(v)
                      )
                    : undefined,
                  fitSectors:
                    Array.isArray(uiPayload.map_fit_sectors) ?
                      (uiPayload.map_fit_sectors as number[]).filter(
                        (v) => typeof v === "number" && Number.isFinite(v)
                      )
                    : undefined,
                  clearCoursePlot: uiPayload.clear_course_plot === true,
                })
              }

              // Inject sub-agent message into the conversation panel
              if (typeof uiPayload.show_panel === "string") {
                useConversationStore.getState().injectMessage({
                  role: "ui",
                  parts: [
                    {
                      text: "Show Panel(" + (uiPayload.show_panel as UIMode | "default") + ")",
                      final: true,
                      createdAt: new Date().toISOString(),
                    },
                  ],
                })
              } else if (typeof uiPayload.show_modal === "string") {
                useConversationStore.getState().injectMessage({
                  role: "ui",
                  parts: [
                    {
                      text: "Open Modal(" + (uiPayload.show_modal as UIModal) + ")",
                      final: true,
                      createdAt: new Date().toISOString(),
                    },
                  ],
                })
              } else {
                useConversationStore.getState().injectMessage({
                  role: "ui",
                  parts: [
                    {
                      text: "Map Action",
                      final: true,
                      createdAt: new Date().toISOString(),
                    },
                  ],
                })
              }
              break
            }

            case "ui-agent-context-summary": {
              console.debug("[GAME EVENT] UI agent context summary", e.payload)
              const data = e.payload as Msg.UIAgentContextSummaryMessage
              useConversationStore.getState().injectMessage({
                role: "system",
                parts: [
                  {
                    text: data.context_summary,
                    final: true,
                    createdAt: new Date().toISOString(),
                  },
                ],
              })
              break
            }

            case "llm.context_summarized": {
              const data = e.payload as Msg.ContextSummarizedMessage
              useConversationStore.getState().injectMessage({
                role: "ui",
                parts: [
                  {
                    text: `Context summarized: ${data.original_message_count} → ${data.new_message_count} messages (${data.summarized_message_count} compressed, ${data.preserved_message_count} preserved)`,
                    final: true,
                    createdAt: new Date().toISOString(),
                  },
                ],
              })
              break
            }

            // ----- HISTORY QUERIES

            case "task.history": {
              console.debug("[GAME EVENT] Task history", e.payload)
              const data = e.payload as Msg.TaskHistoryMessage
              useGameStore.getState().setTaskHistory(data.tasks)
              break
            }

            case "chat.history": {
              console.debug("[GAME EVENT] Chat history", e.payload)
              const data = e.payload as Msg.ChatHistoryMessage
              useGameStore.getState().setChatHistory(data.messages)
              break
            }

            case "ships.list": {
              console.debug("[GAME EVENT] Ships list", e.payload)
              const data = e.payload as Msg.ShipsListMessage
              useGameStore.getState().setShips(data.ships)
              useGameStore.getState().resolveFetchPromise("get-my-ships")
              break
            }

            case "event.query": {
              console.debug("[GAME EVENT] Event query", e.payload)
              const data = e.payload as Msg.EventQueryMessage
              useGameStore.getState().setTaskEvents(data.events)
              break
            }

            // ----- DEBUG
            case "debug.llm-context": {
              useGameStore.getState().setDebugLLMContext(e.payload.formatted as string)
              break
            }
            case "debug.task-context": {
              useGameStore.getState().setDebugTaskContext(e.payload.formatted as string)
              break
            }
            case "debug.task-context-error": {
              useGameStore.getState().setDebugTaskContextError(e.payload.error as string)
              break
            }

            // ----- TUTORIAL
            case "tutorial.start": {
              useGameStore.getState().handleTutorialStart()
              useAudioStore.getState().fadeIn("tutorial", { volume: 0.3, duration: 6000 })
              break
            }
            case "tutorial.step": {
              useGameStore.getState().handleTutorialStep({
                target: e.payload.target as string | undefined,
                step: e.payload.step as number,
              })
              break
            }
            case "tutorial.complete": {
              useGameStore.getState().handleTutorialComplete()
              useAudioStore.getState().fadeOut("tutorial", { duration: 2000 })
              useConversationStore.getState().clearMessages()
              break
            }

            // ----- UNHANDLED :(
            default:
              console.warn("[GAME EVENT] Unhandled server action:", e.event, e.payload)
          }

          // ----- SUMMARY
          // Add any summary messages to task output
          /*if ("summary" in (e.payload as Msg.ServerMessagePayload)) {
            console.debug(
              "[GAME] Adding task summary to store",
              e.payload.summary
            );
            useGameStore.getState().addTask(e.payload.summary!);
          }*/
        }
      },

      [playerSessionId]
    )
  )

  const contextValue = useMemo(
    () => ({ sendUserTextInput, dispatchAction, initialize }),
    [sendUserTextInput, dispatchAction, initialize]
  )

  return <GameContext.Provider value={contextValue}>{children}</GameContext.Provider>
}
