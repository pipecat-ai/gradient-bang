import { type ReactNode, useCallback, useRef } from "react"

import { type APIRequest, RTVIEvent } from "@pipecat-ai/client-js"
import { usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react"

import { GameContext } from "@/hooks/useGameContext"
import useGameStore, { GameInitStateMessage } from "@/stores/game"
import { wait } from "@/utils/animation"
import {
  hasDeviatedFromCoursePlot,
  salvageCollectedSummaryString,
  salvageCreatedSummaryString,
  transferSummaryString,
} from "@/utils/game"

import type { StarfieldSceneConfig } from "./fx/starfield"
import GameInstanceManager from "./GameInstanceManager"
import type { Action, StartAction } from "./types/actions"
import { RESOURCE_SHORT_NAMES } from "./types/constants"

import {
  type BankTransactionMessage,
  type CharacterMovedMessage,
  type CombatActionResponseMessage,
  type CombatRoundResolvedMessage,
  type CombatRoundWaitingMessage,
  type CoursePlotMessage,
  type CreditsTransferMessage,
  type ErrorMessage,
  type EventQueryMessage,
  type IncomingChatMessage,
  type MapLocalMessage,
  type MovementCompleteMessage,
  type MovementStartMessage,
  type PortUpdateMessage,
  type SalvageCollectedMessage,
  type SalvageCreatedMessage,
  type SectorUpdateMessage,
  type ServerMessage,
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
  onConnect?: (request: APIRequest) => void
}

//@TODO: remove this method once game server changes
const transformMessage = (e: ServerMessage): ServerMessage | undefined => {
  if (["tool_result", "tool_call"].includes(e.event)) {
    console.debug(
      "[GAME EVENT] Transforming server message",
      e.event,
      e.payload
    )
    console.warn("[GAME EVENT] Removing server message as legacy", e)
    return undefined
  }
  return e
}

export function GameProvider({ children, onConnect }: GameProviderProps) {
  const gameStore = useGameStore()
  const client = usePipecatClient()

  const instanceManagerRef = useRef<GameInstanceManager | null>(null)

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
        console.error(
          `[GAME CONTEXT] Client not ready. Current state: ${client.state}`
        )
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

  /**
   * Dispatch game action to server
   */
  const dispatchAction = useCallback(
    (action: Action) => {
      if (!client) {
        console.error("[GAME CONTEXT] Client not available")
        return
      }
      if (client.state !== "ready") {
        console.error(
          `[GAME CONTEXT] Client not ready. Current state: ${client.state}`
        )
        return
      }
      console.debug(
        `[GAME CONTEXT] Dispatching action: "${action.type}"`,
        action.payload
      )
      client.sendClientMessage(action.type, action.payload ?? {})
    },
    [client]
  )

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

    // Create the instance manager if it doesn't exist
    if (!instanceManagerRef.current) {
      console.debug("[GAME CONTEXT] Creating game instance manager")
      instanceManagerRef.current = new GameInstanceManager()
    }

    gameStore.setGameStateMessage(GameInitStateMessage.INIT)
    gameStore.setGameState("initializing")

    // 1. Construct and await heavier game instances
    await instanceManagerRef.current?.create_instances()
    await wait(1000)

    // 2. Connect to agent
    gameStore.setGameStateMessage(GameInitStateMessage.CONNECTING)

    const characterId = gameStore.character_id
    const accessToken = gameStore.access_token
    if (!gameStore.settings.bypassTitle && (!characterId || !accessToken)) {
      throw new Error(
        "Attempting to connect to bot without a character ID or access token"
      )
    }
    const botStartParams = gameStore.getBotStartParams(characterId, accessToken)

    console.debug("[GAME CONTEXT] Connecting with params", botStartParams)

    try {
      await onConnect?.(botStartParams)
      if (!client?.connected) {
        throw new Error("Failed to connect to game server")
      }
    } catch {
      console.error("[GAME CONTEXT] Error connecting to game server")
      gameStore.setGameState("error")
      return
    }

    // 3. Wait for initial data and initialize anything that needs it
    await instanceManagerRef.current?.initialize()
    gameStore.setGameStateMessage(GameInitStateMessage.STARTING)

    console.debug("[GAME CONTEXT] Initialized, setting ready state")

    // 4. Set ready state and dispatch start event to bot
    gameStore.setGameStateMessage(GameInitStateMessage.READY)
    gameStore.setGameState("ready")

    // A little bit of air, so the bot starts talking after the visor opens
    await wait(1000)

    // 5. Dispatch start event to bot to kick off the conversation
    dispatchAction({ type: "start" } as StartAction)
  }, [onConnect, gameStore, dispatchAction, client])

  /**
   * Handle server message
   */
  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (e: ServerMessage) => {
        if ("event" in e) {
          console.debug("[GAME EVENT] Server message received", e.event, e)

          // Transform server message tool call responses to normalized event messages
          // @TODO: remove this once game server changes
          const gameEvent = transformMessage(e)
          if (!gameEvent) {
            return
          }

          switch (gameEvent.event) {
            // ----- STATUS
            case "status.snapshot":
            case "status.update": {
              console.debug("[GAME EVENT] Status update", gameEvent.payload)

              const status = gameEvent.payload as StatusMessage

              // Update store
              gameStore.setState({
                player: status.player,
                ship: status.ship,
                sector: status.sector,
              })

              // Initialize game client if this is the first status update
              if (status.source?.method === "join") {
                gameStore.addActivityLogEntry({
                  type: "join",
                  message: "Joined the game",
                })
              }

              break
            }

            // ----- CHARACTERS / NPCS
            case "character.moved": {
              console.debug("[GAME EVENT] Character moved", gameEvent.payload)
              const data = gameEvent.payload as CharacterMovedMessage

              if (data.movement === "arrive") {
                console.debug(
                  "[GAME EVENT] Adding player to sector",
                  gameEvent.payload
                )
                gameStore.addSectorPlayer(data.player)
                gameStore.addActivityLogEntry({
                  type: "character.moved",
                  message: `[${data.player.name}] arrived in sector`,
                  meta: {
                    silent: true,
                  },
                })
              } else if (data.movement === "depart") {
                console.debug(
                  "[GAME EVENT] Removing player from sector",
                  gameEvent.payload
                )
                gameStore.removeSectorPlayer(data.player)
                gameStore.addActivityLogEntry({
                  type: "character.moved",
                  message: `[${data.player.name}] departed from sector`,
                  meta: {
                    silent: true,
                  },
                })
              } else {
                console.warn(
                  "[GAME EVENT] Unknown movement type",
                  data.movement
                )
              }

              break
            }

            // ----- MOVEMENT
            case "movement.start": {
              console.debug("[GAME EVENT] Move started", gameEvent.payload)
              const data = gameEvent.payload as MovementStartMessage

              const gameStore = useGameStore.getState()

              // Store a reference to the sector to be moved to
              // We don't update client to reference the new sector yet
              // to support animation sequencing and debouncing (task-based movement)
              const newSector = data.sector
              gameStore.setSectorBuffer(newSector)

              console.debug("[GAME] Starting movement action", newSector)

              gameStore.setUIState("moving")

              // @TODO: move this logic to the game instance manager
              const starfield = gameStore.starfieldInstance

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
              })

              break
            }

            case "movement.complete": {
              console.debug("[GAME EVENT] Move completed", gameEvent.payload)
              const data = gameEvent.payload as MovementCompleteMessage

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
                last_visited: data.first_visit
                  ? undefined
                  : new Date().toISOString(),
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

              // Cleanup

              const newSectorId = gameStore.sectorBuffer?.id ?? 0
              // Remove any course plot data if we've reached our intended destination or deviated
              // @TODO: make this logic robust (plots should become stale after a certain time)
              if (gameStore.course_plot?.to_sector === newSectorId) {
                console.debug(
                  "[GAME EVENT] Reached intended destination, clearing course plot"
                )
                gameStore.clearCoursePlot()
              }
              // Remove active course plot if we've gone to a sector outside of the plot
              if (
                hasDeviatedFromCoursePlot(gameStore.course_plot, newSectorId)
              ) {
                console.debug(
                  "[GAME EVENT] Went to a sector outside of the plot, clearing"
                )
                gameStore.clearCoursePlot()
              }
              break
            }

            case "bank.transaction": {
              console.debug("[GAME EVENT] Deposit", gameEvent.payload)
              const data = gameEvent.payload as BankTransactionMessage

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

            // ----- MAP

            case "sector.update": {
              console.debug("[GAME EVENT] Sector update", gameEvent.payload)
              const data = gameEvent.payload as SectorUpdateMessage

              gameStore.setSector(data as Sector)

              // Note: not updating activity log as redundant from other logs

              //gameStore.addActivityLogEntry({
              //  type: "sector.update",
              //  message: `Sector ${data.id} updated`,
              //});

              break
            }

            case "salvage.created": {
              console.debug("[GAME EVENT] Salvage created", gameEvent.payload)
              const data = gameEvent.payload as SalvageCreatedMessage

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
              console.debug("[GAME EVENT] Salvage claimed", gameEvent.payload)
              const data = gameEvent.payload as SalvageCollectedMessage

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
              console.debug("[GAME EVENT] Course plot", gameEvent.payload)
              const data = gameEvent.payload as CoursePlotMessage

              gameStore.setCoursePlot(data)
              break
            }

            case "map.region": {
              console.debug("[GAME EVENT] Regional map data", gameEvent.payload)

              gameStore.setRegionalMapData(
                (gameEvent.payload as MapLocalMessage).sectors
              )
              break
            }

            case "map.local": {
              console.debug("[GAME EVENT] Local map data", gameEvent.payload)

              gameStore.setLocalMapData(
                (gameEvent.payload as MapLocalMessage).sectors
              )
              break
            }

            // ----- TRADING & COMMERCE

            case "trade.executed": {
              console.debug("[GAME EVENT] Trade executed", gameEvent.payload)
              const data = gameEvent.payload as TradeExecutedMessage

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
              console.debug("[GAME EVENT] Port update", gameEvent.payload)
              const data = gameEvent.payload as PortUpdateMessage

              // If update is for current sector, update port payload
              gameStore.updateSector(data.sector)

              break
            }

            case "ports.list": {
              console.debug("[GAME EVENT] Port list", gameEvent.payload)
              // @TODO: implement - waiting on shape of event to align to schema
              //const data = gameEvent.payload as KnownPortListMessage;
              //gameStore.setKnownPorts(data.ports);
              break
            }

            case "warp.purchase": {
              console.debug("[GAME EVENT] Warp purchase", gameEvent.payload)
              const data = gameEvent.payload as WarpPurchaseMessage

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
              const eventType = gameEvent.event as
                | "warp.transfer"
                | "credits.transfer"
              const transferType =
                eventType === "warp.transfer" ? "Warp" : "Credits"

              console.debug(
                `[GAME EVENT] ${transferType} transfer`,
                gameEvent.payload
              )

              const data = gameEvent.payload as
                | WarpTransferMessage
                | CreditsTransferMessage

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
              console.debug(
                "[GAME EVENT] Combat round waiting",
                gameEvent.payload
              )
              const data = gameEvent.payload as CombatRoundWaitingMessage

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
              console.debug(
                "[GAME EVENT] Combat round resolved",
                gameEvent.payload
              )
              const data = gameEvent.payload as CombatRoundResolvedMessage
              gameStore.addCombatRound(data as CombatRound)
              gameStore.addActivityLogEntry({
                type: "combat.round.resolved",
                message: `Combat round ${data.round} resolved in sector ${data.sector.id}`,
              })
              break
            }

            case "combat.action_response": {
              console.debug(
                "[GAME EVENT] Combat action response",
                gameEvent.payload
              )
              const data = gameEvent.payload as CombatActionResponseMessage

              // @TODO: update store to log action round action

              gameStore.addActivityLogEntry({
                type: "combat.action.response",
                message: `Combat action response for round ${data.round}: [${data.action}]`,
              })
              break
            }

            case "combat.ended": {
              console.debug("[GAME EVENT] Combat ended", gameEvent.payload)
              const data = gameEvent.payload as CombatRoundResolvedMessage

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
              console.debug("[GAME EVENT] Ship destroyed", gameEvent.payload)
              const data = gameEvent.payload as ShipDestroyedMessage

              const shipDescription =
                data.player_type === "corporation_ship"
                  ? `Corporation ship [${data.ship_name ?? data.ship_type}]`
                  : `[${data.player_name}]'s ship`

              gameStore.addActivityLogEntry({
                type: "ship.destroyed",
                message: `${shipDescription} destroyed in [sector ${data.sector.id}]${data.salvage_created ? " - salvage created" : ""}`,
              })

              break
            }

            // ----- MISC

            case "chat.message": {
              console.debug("[GAME EVENT] Chat message", gameEvent.payload)
              const data = gameEvent.payload as IncomingChatMessage

              gameStore.addMessage(data as ChatMessage)
              gameStore.setNotifications({ newChatMessage: true })

              const timestampClient = Date.now()

              if (
                data.type === "direct" &&
                data.from_name &&
                data.from_name !== gameStore.player?.name
              ) {
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

            case "error": {
              console.debug("[GAME EVENT] Error", gameEvent.payload)
              const data = gameEvent.payload as ErrorMessage

              // @TODO: keep tabs on errors in separate store

              gameStore.addActivityLogEntry({
                type: "error",
                message: `Ship Protocol Failure: ${
                  data.endpoint ?? "Unknown"
                } - ${data.error}`,
              })
              break
            }

            case "ui-action": {
              console.debug("[GAME EVENT] UI action", gameEvent.payload)

              /*const starfield = gameStore.starfieldInstance;
              if (starfield) {
                starfield.selectGameObject("port");
              }

              gameStore.setActiveScreen("trading");*/

              break
            }

            case "task_output": {
              console.debug("[GAME EVENT] Task output", gameEvent.payload)
              const data = gameEvent.payload as TaskOutputMessage
              gameStore.setTaskInProgress(true)
              gameStore.addTask(data.text, data.task_message_type)

              // @TODO Properly handle task failure.
              // Right now, we treat them as cancellations
              if (data.task_message_type === "FAILED") {
                gameStore.setTaskWasCancelled(true)
              }
              break
            }

            case "task.start": {
              console.debug("[GAME EVENT] Task start", gameEvent.payload)
              const data = gameEvent.payload as TaskStartMessage
              if (data.task_id) {
                gameStore.addActiveTask({
                  task_id: data.task_id,
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
              console.debug("[GAME EVENT] Task finish", gameEvent.payload)
              const data = gameEvent.payload as TaskFinishMessage
              if (data.task_id) {
                gameStore.removeActiveTask(data.task_id)
              }
              if (data.task_status === "cancelled") {
                gameStore.setTaskWasCancelled(true)
              }
              break
            }

            case "task_complete": {
              console.debug("[GAME EVENT] Task complete", gameEvent.payload)
              const data = gameEvent.payload as TaskCompleteMessage

              gameStore.setTaskInProgress(false)
              gameStore.addActivityLogEntry({
                type: "task.complete",
                message: `${
                  data.was_cancelled ? "Task cancelled" : "Task completed"
                }`,
              })

              //@TODO Properly handle task failures
              if (data.was_cancelled) {
                gameStore.setTaskWasCancelled(true)
              }
              break
            }

            // ----- HISTORY QUERIES

            case "task.history": {
              console.debug("[GAME EVENT] Task history", gameEvent.payload)
              const data = gameEvent.payload as TaskHistoryMessage
              gameStore.setTaskHistory(data.tasks)
              break
            }

            case "ships.list": {
              console.debug("[GAME EVENT] Ships list", gameEvent.payload)
              const data = gameEvent.payload as ShipsListMessage
              gameStore.setUserShips(data.ships)
              break
            }

            case "event.query": {
              console.debug("[GAME EVENT] Event query", gameEvent.payload)
              const data = gameEvent.payload as EventQueryMessage
              gameStore.setTaskEvents(data.events)
              break
            }

            // ----- UNHANDLED :(
            default:
              console.warn(
                "[GAME EVENT] Unhandled server action:",
                gameEvent.event,
                gameEvent.payload
              )
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
      [gameStore]
    )
  )

  return (
    <GameContext.Provider
      value={{ sendUserTextInput, dispatchAction, initialize }}
    >
      {children}
    </GameContext.Provider>
  )
}
