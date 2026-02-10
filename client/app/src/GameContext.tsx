import { type ReactNode, useCallback } from "react"

import { RTVIEvent } from "@pipecat-ai/client-js"
import { usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react"

import { GameContext } from "@/hooks/useGameContext"
import useGameStore, { GameInitStateMessage } from "@/stores/game"
import {
  salvageCollectedSummaryString,
  salvageCreatedSummaryString,
  transferSummaryString,
} from "@/utils/game"
import {
  DEFAULT_MAX_BOUNDS,
  MAX_BOUNDS,
  MAX_BOUNDS_PADDING,
  MIN_BOUNDS,
  getNextZoomLevel,
} from "@/utils/mapZoom"

import { RESOURCE_SHORT_NAMES } from "./types/constants"

import {
  type BankTransactionMessage,
  type CharacterMovedMessage,
  type ChatHistoryMessage,
  type CombatActionResponseMessage,
  type CombatRoundResolvedMessage,
  type CombatRoundWaitingMessage,
  type CorporationCreatedMessage,
  type CorporationShipPurchaseMessage,
  type CoursePlotMessage,
  type CreditsTransferMessage,
  type ErrorMessage,
  type EventQueryMessage,
  type IncomingChatMessage,
  type LLMTaskMessage,
  type MapLocalMessage,
  type MovementCompleteMessage,
  type MovementStartMessage,
  type PortUpdateMessage,
  type SalvageCollectedMessage,
  type SalvageCreatedMessage,
  type SectorUpdateMessage,
  type ServerMessage,
  type ServerMessagePayload,
  type ShipDestroyedMessage,
  type ShipsListMessage,
  type StatusMessage,
  type TaskCompleteMessage,
  type TaskFinishMessage,
  type TaskHistoryMessage,
  type TaskOutputMessage,
  type TaskStartMessage,
  type TradeExecutedMessage,
  type WarpPurchaseMessage,
  type WarpTransferMessage,
} from "@/types/messages"

interface GameProviderProps {
  children: ReactNode
}

export function GameProvider({ children }: GameProviderProps) {
  const gameStore = useGameStore()
  const client = usePipecatClient()
  const playerSessionId = useGameStore((state) => state.playerSessionId)
  const dispatchAction = useGameStore((state) => state.dispatchAction)

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

  // Dev-only: Expose to console using globalThis
  if (import.meta.env.DEV) {
    // @ts-expect-error - Dev-only console helper
    globalThis.sendUserTextInput = sendUserTextInput
  }

  // Dev-only: Expose to console using globalThis
  if (import.meta.env.DEV) {
    // @ts-expect-error - Dev-only console helper
    globalThis.dispatchAction = dispatchAction
  }

  /**
   * Initialization method
   */
  const initialize = useCallback(async () => {
    console.debug("[GAME CONTEXT] Initializing...")

    // Set initial state
    gameStore.setPlayerSessionId(null)
    gameStore.setGameStateMessage(GameInitStateMessage.INIT)
    gameStore.setGameState("initializing")

    // 1. Construct and await heavier game instances
    if (gameStore.settings.renderStarfield) {
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
    gameStore.setGameStateMessage(GameInitStateMessage.CONNECTING)

    const characterId = gameStore.character_id
    const accessToken = gameStore.access_token
    if (!gameStore.settings.bypassTitle && (!characterId || !accessToken)) {
      throw new Error("Attempting to connect to bot without a character ID or access token")
    }
    const botStartParams = gameStore.getBotStartParams(characterId, accessToken)

    console.debug("[GAME CONTEXT] Connecting with params", botStartParams)

    try {
      await client?.startBotAndConnect(botStartParams)
      if (!client?.connected) {
        throw new Error("Failed to connect to game server")
      }
    } catch {
      console.error("[GAME CONTEXT] Error connecting to game server")
      gameStore.setGameState("error")
      return
    }

    // 3. Wait for initial data and initialize anything that needs it
    // @TODO: pass initial config to starfield here
    gameStore.setGameStateMessage(GameInitStateMessage.READY)

    console.debug("[GAME CONTEXT] Initialized, setting ready state")

    // 4. Set ready state and dispatch start event to bot
    gameStore.setGameStateMessage(GameInitStateMessage.READY)
    gameStore.setGameState("ready")

    // 5. Dispatch start event to bot to kick off the conversation
    // dispatchAction({ type: "start" } as StartAction)
  }, [gameStore, client])

  /**
   * Handle server message
   */
  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (e: ServerMessage) => {
        if ("event" in e) {
          console.debug("[GAME EVENT] Server message received", e.event, e)

          // Helper functions
          const getPayloadPlayerId = (payload: ServerMessagePayload): string | undefined => {
            if (payload.player && typeof payload.player.id === "string" && payload.player.id) {
              return payload.player.id
            }
            return undefined
          }

          const logMissingPlayerId = (eventName: string, payload: ServerMessagePayload) => {
            console.warn(`[GAME EVENT] Missing player.id for ${eventName}`, payload)
          }

          const logIgnored = (eventName: string, reason: string, payload: ServerMessagePayload) => {
            console.debug(
              `%c[GAME EVENT] Ignoring ${eventName} (${reason})`,
              "color: #000; background: #CCC",
              payload
            )
          }

          const isPlayerSessionPayload = (
            eventName: string,
            payload: ServerMessagePayload
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
            // ----- STATUS
            case "status.snapshot":
            case "status.update": {
              console.debug("[GAME EVENT] Status update", e.payload)

              const status = e.payload as StatusMessage

              if (e.event === "status.snapshot" && status.player.player_type === "human") {
                if (!status.player.id) {
                  logMissingPlayerId(e.event, status)
                }
              }

              // Initialize game client if this is the first status update
              if (status.source?.method === "join") {
                // Note: we only mutate when `playerSessionId` is null retain
                // a source of truth on client creation
                if (!gameStore.playerSessionId) {
                  console.debug(
                    "%c[GAME EVENT] status.update join event, setting player session ID",
                    "color: #ffffff; background: #000000",
                    status.player.id
                  )
                  gameStore.setPlayerSessionId(status.player.id)
                }

                gameStore.addActivityLogEntry({
                  type: "join",
                  message: "Joined the game",
                })
              }

              // Handle status update accordingly
              if (isPlayerSessionPayload(e.event, status)) {
                // Update store
                gameStore.setState({
                  player: status.player,
                  corporation: status.corporation,
                  ship: status.ship,
                  sector: status.sector,
                })
              } else if (status.player.player_type === "corporation_ship") {
                if (!status.ship.ship_id) {
                  console.warn(
                    "[GAME EVENT] Status update missing ship_id for corporation ship",
                    status
                  )
                  break
                }
                const shipUpdate: Partial<ShipSelf> & { ship_id: string } = {
                  ...status.ship,
                  ship_id: status.ship.ship_id,
                }
                if (typeof status.sector?.id === "number") {
                  shipUpdate.sector = status.sector.id
                }
                gameStore.updateShip(shipUpdate)
              } else {
                logIgnored(e.event, `player ${status.player.id}`, status)
              }

              break
            }

            // ----- CHARACTERS / NPCS
            case "character.moved": {
              console.debug("[GAME EVENT] Character moved", e.payload)
              const data = e.payload as CharacterMovedMessage

              const sectorId = typeof data.sector === "number" ? data.sector : data.sector?.id
              const currentSectorId = gameStore.sector?.id
              const isLocalSector =
                typeof sectorId === "number" &&
                typeof currentSectorId === "number" &&
                sectorId === currentSectorId

              if (isLocalSector) {
                if (data.movement === "arrive") {
                  console.debug("[GAME EVENT] Adding player to sector", e.payload)
                  gameStore.addSectorPlayer(data.player)
                  gameStore.addActivityLogEntry({
                    type: "character.moved",
                    message: `[${data.player.name}] arrived in sector`,
                    meta: {
                      player: data.player,
                      sector: data.sector,
                      direction: "arrive",
                      silent: true,
                    },
                  })
                } else if (data.movement === "depart") {
                  console.debug("[GAME EVENT] Removing player from sector", e.payload)
                  gameStore.removeSectorPlayer(data.player)
                  gameStore.addActivityLogEntry({
                    type: "character.moved",
                    message: `[${data.player.name}] departed from sector`,
                    meta: {
                      player: data.player,
                      sector: data.sector,
                      direction: "depart",
                      silent: true,
                    },
                  })
                } else {
                  console.warn("[GAME EVENT] Unknown movement type", data.movement)
                }
              } else {
                logIgnored("character.moved", "non-local sector", data)
              }

              // Update corp ship position icons regardless of sector visibility
              if (data.ship?.ship_id && typeof sectorId === "number") {
                gameStore.updateShip({
                  ship_id: data.ship.ship_id,
                  sector: sectorId,
                })
              } else if (!data.ship?.ship_id) {
                console.warn("[GAME EVENT] character.moved missing ship_id", data)
              }

              break
            }

            // ----- MOVEMENT
            case "movement.start": {
              console.debug("[GAME EVENT] Move started", e.payload)
              const data = e.payload as MovementStartMessage
              if (!isPlayerSessionPayload("movement.start", data)) {
                break
              }

              const gameStore = useGameStore.getState()

              // Store a reference to the sector to be moved to
              // We don't update client to reference the new sector yet
              // to support animation sequencing and debouncing (task-based movement)
              const newSector = data.sector
              gameStore.setSectorBuffer(newSector)

              console.debug("[GAME] Starting movement action", newSector)

              gameStore.setUIState("moving")

              // @TODO: implement starfield warpToSector

              /*
              if (!starfield || !gameStore.settings.renderStarfield) {
                console.error(
                  "[GAME] Starfield instance not found / disabled, skipping animation"
                )
                break
              }
              console.debug("[GAME] Updating Starfield to", newSector)

              starfield.warpToSector({
                id: newSector.id.toString(),
                sceneConfig:
                  newSector.scene_config as Partial<StarfieldSceneConfig>,
                gameObjects: newSector.port
                  ? [{ id: "port", type: "port", name: "Port" }]
                  : undefined,
                bypassAnimation: gameStore.settings.fxBypassAnimation,
                bypassFlash: gameStore.settings.fxBypassFlash,
              })*/

              break
            }

            case "movement.complete": {
              console.debug("[GAME EVENT] Move completed", e.payload)
              const data = e.payload as MovementCompleteMessage
              if (!isPlayerSessionPayload("movement.complete", data)) {
                break
              }

              // Update ship and player
              // This hydrates things like warp power, player last active, etc.
              gameStore.setState({
                ship: data.ship,
                player: data.player,
              })

              // Add entry to movement history
              gameStore.addMovementHistory({
                from: gameStore.sector?.id ?? 0,
                to: gameStore.sectorBuffer?.id ?? 0,
                port: !!gameStore.sectorBuffer?.port,
                last_visited: data.first_visit ? undefined : new Date().toISOString(),
              })

              // Update activity log
              // @TODO: optimize but having movement history and activity log index same data
              gameStore.addActivityLogEntry({
                type: "movement",
                message: `Moved from [sector ${gameStore.sector?.id}] to [sector ${gameStore.sectorBuffer?.id}]`,
              })

              if (data.first_visit) {
                console.debug(
                  `[GAME EVENT] Discovered sector for first time: ${gameStore.sectorBuffer?.id}`
                )
                gameStore.addActivityLogEntry({
                  type: "map.sector.discovered",
                  message: `Discovered [sector ${gameStore.sectorBuffer?.id}]`,
                })
              }

              // Swap in the buffered sector
              // Note: Starfield instance already in sync through animation sequencing
              if (gameStore.sectorBuffer) {
                gameStore.setSector(gameStore.sectorBuffer as Sector)
              }

              gameStore.setUIState("idle")

              break
            }

            case "bank.transaction": {
              console.debug("[GAME EVENT] Deposit", e.payload)
              const data = e.payload as BankTransactionMessage
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

              // Note: we do not need to update the player or ship state
              // as status.update is dispatched immediately after

              if (data.direction === "deposit") {
                gameStore.addActivityLogEntry({
                  type: "bank.transaction",
                  message: `Deposited [${data.amount}] credits to bank`,
                })
              } else {
                gameStore.addActivityLogEntry({
                  type: "bank.transaction",
                  message: `Withdrew [${data.amount}] credits from bank`,
                })
              }

              gameStore.addToast({
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
              const data = e.payload as CorporationCreatedMessage
              gameStore.setCorporation(data)
              break
            }

            case "corporation.disbanded": {
              console.debug("[GAME EVENT] Corporation disbanded", e.payload)
              //const data = e.payload as CorporationDisbandedMessage
              gameStore.setCorporation(undefined)
              break
            }

            case "corporation.ship_purchased": {
              console.debug("[GAME EVENT] Ship purchased", e.payload)
              const data = e.payload as CorporationShipPurchaseMessage
              gameStore.addShip({
                ship_id: data.ship_id,
                ship_name: data.ship_name,
                ship_type: data.ship_type,
                owner_type: "corporation",
                sector: data.sector,
              })
              break
            }

            // ----- MAP

            case "sector.update": {
              console.debug("[GAME EVENT] Sector update", e.payload)
              const data = e.payload as SectorUpdateMessage

              if (gameStore.sector?.id !== data.id) {
                logIgnored("sector.update", "non-current sector", data)
                break
              }
              gameStore.updateSector(data as Sector)

              // Note: not updating activity log as redundant from other logs

              //gameStore.addActivityLogEntry({
              //  type: "sector.update",
              //  message: `Sector ${data.id} updated`,
              //});

              break
            }

            case "salvage.created": {
              console.debug("[GAME EVENT] Salvage created", e.payload)
              const data = e.payload as SalvageCreatedMessage
              const salvagePlayerId = getPayloadPlayerId(data)
              if (salvagePlayerId) {
                if (!isPlayerSessionPayload("salvage.created", data)) {
                  break
                }
              } else {
                const sectorId = data.sector?.id
                if (!sectorId || sectorId !== gameStore.sector?.id) {
                  logIgnored("salvage.created", "non-current sector", data)
                  break
                }
              }

              // Note: we update sector contents in proceeding sector.update event

              // @TODO: status update is missing, so we may need to update player state here

              gameStore.addActivityLogEntry({
                type: "salvage.created",
                message: `Salvage created in [sector ${
                  data.sector.id
                }] ${salvageCreatedSummaryString(data.salvage_details)}`,
              })

              gameStore.addToast({
                type: "salvage.created",
                meta: {
                  salvage: data.salvage_details as Salvage,
                },
              })
              break
            }

            case "salvage.collected": {
              console.debug("[GAME EVENT] Salvage claimed", e.payload)
              const data = e.payload as SalvageCollectedMessage
              if (!isPlayerSessionPayload("salvage.collected", data)) {
                break
              }

              gameStore.addActivityLogEntry({
                type: "salvage.collected",
                message: `Salvage collected in [sector ${
                  data.sector.id
                }] ${salvageCollectedSummaryString(data.salvage_details)}`,
              })

              gameStore.addToast({
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
              const data = e.payload as CoursePlotMessage
              if (!isPlayerSessionPayload(e.event, data)) {
                break
              }

              gameStore.setCoursePlot(data)
              break
            }

            case "map.region": {
              console.debug("[GAME EVENT] Regional map data", e.payload)
              if (!isPlayerSessionPayload("map.region", e.payload as ServerMessagePayload)) {
                break
              }

              const data = e.payload as MapLocalMessage
              gameStore.setRegionalMapData(data.sectors)
              if (Array.isArray(data.fit_sectors) && typeof data.bounds === "number") {
                const clamped = Math.max(MIN_BOUNDS, Math.min(MAX_BOUNDS, data.bounds))
                gameStore.setMapCenterSector(data.center_sector)
                gameStore.setMapZoomLevel(clamped)
                gameStore.clearPendingMapFit()
              }
              break
            }

            case "map.local": {
              console.debug("[GAME EVENT] Local map data", e.payload)
              if (!isPlayerSessionPayload("map.local", e.payload as ServerMessagePayload)) {
                break
              }

              gameStore.setLocalMapData((e.payload as MapLocalMessage).sectors)
              break
            }

            case "map.update": {
              console.debug("[GAME EVENT] Map update", e.payload)
              const data = e.payload as MapLocalMessage
              gameStore.updateMapSectors(data.sectors as MapSectorNode[])
              break
            }

            // ----- TRADING & COMMERCE

            case "trade.executed": {
              console.debug("[GAME EVENT] Trade executed", e.payload)
              const data = e.payload as TradeExecutedMessage
              if (!isPlayerSessionPayload("trade.executed", data)) {
                break
              }

              gameStore.addActivityLogEntry({
                type: "trade.executed",
                message: `Trade executed: ${
                  data.trade.trade_type === "buy" ? "Bought" : "Sold"
                } ${data.trade.units} [${
                  RESOURCE_SHORT_NAMES[data.trade.commodity]
                }] for [CR ${data.trade.total_price}]`,
              })

              gameStore.addToast({
                type: "trade.executed",
                meta: {
                  ...data.trade,
                  old_credits: gameStore.ship?.credits ?? 0,
                },
              })
              break
            }

            case "port.update": {
              console.debug("[GAME EVENT] Port update", e.payload)
              const data = e.payload as PortUpdateMessage

              // If update is for current sector, update port payload
              gameStore.updateSector(data.sector)

              break
            }

            case "ports.list": {
              console.debug("[GAME EVENT] Port list", e.payload)
              // @TODO: implement - waiting on shape of event to align to schema
              //const data = e.payload as KnownPortListMessage;
              //gameStore.setKnownPorts(data.ports);
              break
            }

            case "warp.purchase": {
              console.debug("[GAME EVENT] Warp purchase", e.payload)
              const data = e.payload as WarpPurchaseMessage
              if (!isPlayerSessionPayload("warp.purchase", data)) {
                break
              }

              // Largely a noop as status.update is dispatched immediately after
              // warp purchase. We just update activity log here for now.

              gameStore.addActivityLogEntry({
                type: "warp.purchase",
                message: `Purchased [${data.units}] warp units for [${data.total_cost}] credits`,
              })

              gameStore.addToast({
                type: "warp.purchase",
                meta: {
                  prev_amount: gameStore.ship?.warp_power ?? 0,
                  new_amount: data.new_warp_power,
                  capacity: data.warp_power_capacity,
                  cost: data.total_cost,
                  new_credits: data.new_credits,
                  prev_credits: gameStore.ship?.credits ?? 0,
                },
              })
              break
            }

            case "warp.transfer":
            case "credits.transfer": {
              const eventType = e.event as "warp.transfer" | "credits.transfer"
              const transferType = eventType === "warp.transfer" ? "Warp" : "Credits"

              console.debug(`[GAME EVENT] ${transferType} transfer`, e.payload)

              const data = e.payload as WarpTransferMessage | CreditsTransferMessage
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

              // Note: we do not need to update the player or ship state
              // as status.update is dispatched immediately after

              if (data.transfer_direction === "received") {
                gameStore.triggerAlert("transfer")
              }

              gameStore.addActivityLogEntry({
                type: eventType,
                message: transferSummaryString(data),
              })

              gameStore.addToast({
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
              const data = e.payload as CombatRoundWaitingMessage
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

              // Immediately set the UI state to be "combat" for user feedback
              gameStore.setUIState("combat")

              // Do we have an active combat session?
              if (!gameStore.activeCombatSession) {
                gameStore.setActiveCombatSession(data as CombatSession)
                gameStore.addActivityLogEntry({
                  type: "combat.session.started",
                  message: `Combat session started with ${data.participants.length} participants`,
                })
                break
              }
              // Update combat session with new round details
              break
            }

            case "combat.round_resolved": {
              console.debug("[GAME EVENT] Combat round resolved", e.payload)
              const data = e.payload as CombatRoundResolvedMessage
              const activeCombatId = gameStore.activeCombatSession?.combat_id
              const hasPersonalAction =
                !!playerSessionId &&
                !!data.actions &&
                Object.prototype.hasOwnProperty.call(data.actions, playerSessionId)
              if (!hasPersonalAction && data.combat_id !== activeCombatId) {
                logIgnored("combat.round_resolved", "not part of combat", data)
                break
              }
              gameStore.addCombatRound(data as CombatRound)
              gameStore.addActivityLogEntry({
                type: "combat.round.resolved",
                message: `Combat round ${data.round} resolved in sector ${data.sector.id}`,
              })
              break
            }

            case "combat.action_response": {
              console.debug("[GAME EVENT] Combat action response", e.payload)
              const data = e.payload as CombatActionResponseMessage
              const payloadPlayerId = getPayloadPlayerId(data)
              const activeCombatId = gameStore.activeCombatSession?.combat_id
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

              // @TODO: update store to log action round action

              gameStore.addActivityLogEntry({
                type: "combat.action.response",
                message: `Combat action response for round ${data.round}: [${data.action}]`,
              })
              break
            }

            case "combat.ended": {
              console.debug("[GAME EVENT] Combat ended", e.payload)
              const data = e.payload as CombatRoundResolvedMessage
              const activeCombatId = gameStore.activeCombatSession?.combat_id
              const hasPersonalAction =
                !!playerSessionId &&
                !!data.actions &&
                Object.prototype.hasOwnProperty.call(data.actions, playerSessionId)
              if (!hasPersonalAction && data.combat_id !== activeCombatId) {
                logIgnored("combat.ended", "not part of combat", data)
                break
              }

              // Return to idle UI state
              gameStore.setUIState("idle")

              gameStore.endActiveCombatSession()

              // Update activity log with combat session details
              gameStore.addActivityLogEntry({
                type: "combat.session.ended",
                message: `Combat session ended with result: [${data.result}]`,
              })

              break
            }

            case "ship.destroyed": {
              console.debug("[GAME EVENT] Ship destroyed", e.payload)
              const data = e.payload as ShipDestroyedMessage

              const shipDescription =
                data.player_type === "corporation_ship" ?
                  `Corporation ship [${data.ship_name ?? data.ship_type}]`
                : `[${data.player_name}]'s ship`

              gameStore.addActivityLogEntry({
                type: "ship.destroyed",
                message: `${shipDescription} destroyed in [sector ${data.sector.id}]${data.salvage_created ? " - salvage created" : ""}`,
              })

              break
            }

            // ----- TASKS

            case "task.start": {
              console.debug("[GAME EVENT] Task start", e.payload)
              const data = e.payload as TaskStartMessage

              if (data.task_id) {
                // @TODO: this is to align task messages to task_output messages
                // task.start and task.finish use full uuids, but task_output uses truncated ids
                const truncated_task_id = data.task_id.slice(0, 6)

                gameStore.addActiveTask({
                  task_id: truncated_task_id,
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
              break
            }

            case "task.finish": {
              console.debug("[GAME EVENT] Task finish", e.payload)
              const data = e.payload as TaskFinishMessage

              // Remove task from active task map
              if (data.task_id) {
                // @TODO: this is to align task messages to task_output messages
                // task.start and task.finish use full uuids, but task_output uses truncated ids
                const truncated_task_id = data.task_id.slice(0, 6)
                gameStore.removeActiveTask(truncated_task_id)
              }

              // Add task summary to store
              gameStore.addTaskSummary(data as unknown as TaskSummary)

              // Refetch task history
              gameStore.dispatchAction({ type: "get-task-history", payload: { max_rows: 20 } })
              break
            }

            case "task_output": {
              console.debug("[GAME EVENT] Task output", e, e.payload)
              const data = e.payload as TaskOutputMessage
              if (!e.task_id) {
                console.warn("[GAME EVENT] Task output missing task_id", e.payload)
                return
              }
              gameStore.addTaskOutput({
                task_id: e.task_id,
                text: data.text,
                task_message_type: data.task_message_type,
              })
              break
            }

            case "task_complete": {
              console.debug("[GAME EVENT] Task complete", e.payload)
              const data = e.payload as TaskCompleteMessage

              gameStore.addActivityLogEntry({
                type: "task.complete",
                message: `${data.was_cancelled ? "Task cancelled" : "Task completed"}`,
              })

              //@TODO Properly handle task failures
              if (data.was_cancelled) {
                gameStore.setTaskWasCancelled(true)
              }
              break
            }

            // ----- MISC

            case "chat.message": {
              console.debug("[GAME EVENT] Chat message", e.payload)
              const data = e.payload as IncomingChatMessage

              gameStore.addMessage(data as ChatMessage)

              const timestampClient = Date.now()

              if (
                data.type === "direct" &&
                data.from_name &&
                data.from_name !== gameStore.player?.name
              ) {
                // Show a nofication in the conversation panel
                // @TODO: do not do this if chat window is open
                gameStore.setNotifications({ newChatMessage: true })

                gameStore.addActivityLogEntry({
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

            case "llm.function_call": {
              console.debug("[GAME EVENT] LLM task message", e.payload)
              const data = e.payload as LLMTaskMessage
              gameStore.setLLMIsWorking(!!data.name)
              break
            }

            case "error": {
              console.debug("[GAME EVENT] Error", e.payload)
              const data = e.payload as ErrorMessage

              // @TODO: keep tabs on errors in separate store

              gameStore.addActivityLogEntry({
                type: "error",
                message: `Ship Protocol Failure: ${data.endpoint ?? "Unknown"} - ${data.error}`,
              })
              break
            }

            case "ui-action": {
              console.debug("[GAME EVENT] UI action", e.payload)
              const payload = e.payload as Record<string, unknown>
              if (payload?.["ui-action"] !== "control_ui") {
                break
              }

              const mapCenter =
                typeof payload.map_center_sector === "number" &&
                Number.isFinite(payload.map_center_sector)
                  ? (payload.map_center_sector as number)
                  : undefined
              const mapZoomRaw =
                typeof payload.map_zoom_level === "number" &&
                Number.isFinite(payload.map_zoom_level)
                  ? (payload.map_zoom_level as number)
                  : undefined
              const mapZoom =
                mapZoomRaw !== undefined ?
                  Math.max(MIN_BOUNDS, Math.min(MAX_BOUNDS, mapZoomRaw))
                : undefined
              const highlight = Array.isArray(payload.map_highlight_path) ?
                (payload.map_highlight_path as number[]).filter((v) =>
                  typeof v === "number" && Number.isFinite(v)
                )
              : undefined
              const fit = Array.isArray(payload.map_fit_sectors) ?
                (payload.map_fit_sectors as number[]).filter((v) =>
                  typeof v === "number" && Number.isFinite(v)
                )
              : undefined
              const clearPlot = payload.clear_course_plot === true
              const showPanel =
                payload.show_panel === "map" ? "map"
                : payload.show_panel === "default" ? "default"
                : undefined
              const hasHighlight = Boolean(highlight && highlight.length > 0)
              const hasFit = Boolean(fit && fit.length > 0)
              const zoomOnly =
                mapZoom !== undefined && mapCenter === undefined && !hasHighlight && !hasFit

              const wantsMap =
                mapCenter !== undefined ||
                mapZoom !== undefined ||
                hasHighlight ||
                hasFit
              if (wantsMap) {
                gameStore.setActiveScreen("map")
              }

              if (showPanel === "map") {
                gameStore.setActiveScreen("map")
              } else if (showPanel === "default") {
                gameStore.setActiveScreen(undefined)
              }

              if (mapZoom !== undefined) {
                if (zoomOnly) {
                  const currentZoom =
                    useGameStore.getState().mapZoomLevel ?? DEFAULT_MAX_BOUNDS
                  if (mapZoom !== currentZoom) {
                    const direction = mapZoom < currentZoom ? "in" : "out"
                    const nextZoom = getNextZoomLevel(currentZoom, direction)
                    console.debug("[GAME UI] Zoom step", {
                      currentZoom,
                      requestedZoom: mapZoom,
                      direction,
                      nextZoom,
                    })
                    gameStore.setMapZoomLevel(nextZoom)
                  }
                } else {
                  console.debug("[GAME UI] Zoom absolute", { mapZoom })
                  gameStore.setMapZoomLevel(mapZoom)
                }
              }

              if (mapCenter !== undefined) {
                const state = useGameStore.getState()
                const mapData: MapData = [
                  ...(state.local_map_data ?? []),
                  ...(state.regional_map_data ?? []),
                ]
                const discovered = mapData.filter(
                  (node) => node.visited || node.source
                )
                const centerNode = mapData.find((node) => node.id === mapCenter)
                const isDiscovered = Boolean(
                  centerNode && (centerNode.visited || centerNode.source)
                )
                let centerToUse: number | undefined

                if (isDiscovered) {
                  centerToUse = mapCenter
                } else {
                  const candidates = discovered.length > 0 ? discovered : mapData
                  const targetPos =
                    centerNode?.position ??
                    state.sector?.position ??
                    (candidates[0]?.position ?? undefined)

                  if (targetPos && candidates.length > 0) {
                    let best = candidates[0]
                    let bestDist = Infinity
                    for (const node of candidates) {
                      if (!node.position) continue
                      const dx = node.position[0] - targetPos[0]
                      const dy = node.position[1] - targetPos[1]
                      const dist = dx * dx + dy * dy
                      if (dist < bestDist) {
                        best = node
                        bestDist = dist
                      }
                    }
                    centerToUse = best.id
                  } else if (state.sector?.id) {
                    centerToUse = state.sector.id
                  } else if (candidates[0]) {
                    centerToUse = candidates[0].id
                  }
                }

                if (centerToUse !== undefined) {
                  gameStore.setMapCenterSector(centerToUse)
                  const bounds =
                    (mapZoom ?? useGameStore.getState().mapZoomLevel ?? DEFAULT_MAX_BOUNDS) +
                    MAX_BOUNDS_PADDING
                  gameStore.dispatchAction({
                    type: "get-my-map",
                    payload: {
                      center_sector: centerToUse,
                      bounds,
                    },
                  })
                }
              }

              if (highlight && highlight.length > 0) {
                console.debug("[GAME UI] Apply course plot", {
                  pathLength: highlight.length,
                  from: highlight[0],
                  to: highlight[highlight.length - 1],
                })
                gameStore.setCoursePlot({
                  path: highlight,
                  from_sector: highlight[0],
                  to_sector: highlight[highlight.length - 1],
                  distance: Math.max(0, highlight.length - 1),
                })
              }

              if (fit && fit.length > 0) {
                console.debug("[GAME UI] Fit map to sectors", { count: fit.length })
                gameStore.fitMapToSectors(fit)
              }

              if (clearPlot) {
                gameStore.clearCoursePlot()
              }
              break
            }

            // ----- HISTORY QUERIES

            case "task.history": {
              console.debug("[GAME EVENT] Task history", e.payload)
              const data = e.payload as TaskHistoryMessage
              gameStore.setTaskHistory(data.tasks)
              break
            }

            case "chat.history": {
              console.debug("[GAME EVENT] Chat history", e.payload)
              const data = e.payload as ChatHistoryMessage
              gameStore.setChatHistory(data.messages)
              break
            }

            case "ships.list": {
              console.debug("[GAME EVENT] Ships list", e.payload)
              const data = e.payload as ShipsListMessage
              gameStore.setShips(data.ships)
              gameStore.resolveFetchPromise("get-my-ships")
              break
            }

            case "event.query": {
              console.debug("[GAME EVENT] Event query", e.payload)
              const data = e.payload as EventQueryMessage
              gameStore.setTaskEvents(data.events)
              break
            }

            // ----- UNHANDLED :(
            default:
              console.warn("[GAME EVENT] Unhandled server action:", e.event, e.payload)
          }

          // ----- SUMMARY
          // Add any summary messages to task output
          /*if ("summary" in (e.payload as ServerMessagePayload)) {
            console.debug(
              "[GAME] Adding task summary to store",
              e.payload.summary
            );
            gameStore.addTask(e.payload.summary!);
          }*/
        }
      },

      [gameStore, playerSessionId]
    )
  )

  return (
    <GameContext.Provider value={{ sendUserTextInput, dispatchAction, initialize }}>
      {children}
    </GameContext.Provider>
  )
}
