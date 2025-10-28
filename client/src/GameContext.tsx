import { RTVIEvent } from "@pipecat-ai/client-js";
import { usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

import { checkForNewSectors, startMoveToSector } from "@/actions";
import { GameContext } from "@/hooks/useGameContext";
import { wait } from "@/utils/animation";
import useGameStore, { GameInitStateMessage } from "@stores/game";

import { RESOURCE_SHORT_NAMES } from "@/types/constants";
import {
  type BankTransactionMessage,
  type CharacterMovedMessage,
  type CoursePlotMessage,
  type CreditsTransferMessage,
  type ErrorMessage,
  type IncomingChatMessage,
  type MapLocalMessage,
  type MovementCompleteMessage,
  type MovementStartMessage,
  type PortUpdateMessage,
  type SalvageCollectedMessage,
  type SalvageCreatedMessage,
  type SectorUpdateMessage,
  type ServerMessage,
  type StatusMessage,
  type WarpPurchaseMessage,
  type WarpTransferMessage,
} from "@/types/messages";
import GameInstanceManager from "./GameInstanceManager";

interface GameProviderProps {
  children: ReactNode;
  onConnect?: () => void;
}

//@TODO: remove this method once game server changes
const transformMessage = (e: ServerMessage): ServerMessage | undefined => {
  if (["tool_result", "tool_call"].includes(e.event)) {
    console.debug(
      "[GAME EVENT] Transforming server message",
      e.event,
      e.payload
    );
    console.warn("[GAME EVENT] Removing server message as legacy", e);
    return undefined;
  }
  return e;
};

export function GameProvider({ children, onConnect }: GameProviderProps) {
  const gameStore = useGameStore();
  const client = usePipecatClient();

  const instanceManagerRef = useRef<GameInstanceManager | null>(null);

  useEffect(() => {
    if (!client) return;

    if (!instanceManagerRef.current) {
      instanceManagerRef.current = new GameInstanceManager();
    }

    return () => {
      instanceManagerRef.current?.destroy();
      instanceManagerRef.current = null;
    };
  }, [client]);

  /**
   * Send user text input to server
   */
  const sendUserTextInput = useCallback(
    (text: string) => {
      if (!client) {
        console.error("[GAME CONTEXT] Client not available");
        return;
      }
      if (client.state !== "ready") {
        console.error(
          `[GAME CONTEXT] Client not ready. Current state: ${client.state}`
        );
        return;
      }
      console.debug(`[GAME CONTEXT] Sending user text input: "${text}"`);
      client.sendClientMessage("user-text-input", { text });
    },
    [client]
  );

  // Dev-only: Expose to console using globalThis
  if (import.meta.env.DEV) {
    // @ts-expect-error - Dev-only console helper
    globalThis.sendUserTextInput = sendUserTextInput;
  }

  /**
   * Dispatch game event to server
   */
  const dispatchEvent = useCallback(
    (e: { type: string; payload?: unknown }) => {
      if (!client) {
        console.error("[GAME CONTEXT] Client not available");
        return;
      }
      if (client.state !== "ready") {
        console.error(
          `[GAME CONTEXT] Client not ready. Current state: ${client.state}`
        );
        return;
      }
      console.debug(`[GAME CONTEXT] Dispatching event: "${e.type}"`, e.payload);
      client.sendClientMessage(e.type, e.payload ?? {});
    },
    [client]
  );

  // Dev-only: Expose to console using globalThis
  if (import.meta.env.DEV) {
    // @ts-expect-error - Dev-only console helper
    globalThis.dispatchEvent = dispatchEvent;
  }

  /**
   * Initialization method
   */
  const initialize = useCallback(async () => {
    console.debug("[GAME CONTEXT] Initializing...", onConnect);

    if (!instanceManagerRef.current) {
      console.error("[GAME CONTEXT] Game instance manager not found");
      return;
    }

    gameStore.setGameStateMessage(GameInitStateMessage.INIT);
    gameStore.setGameState("initializing");

    // 1. Construct and await heavier game instances
    await instanceManagerRef.current?.create_instances();

    // 2. Connect to agent
    gameStore.setGameStateMessage(GameInitStateMessage.CONNECTING);
    try {
      await onConnect?.();
      if (!client?.connected) {
        throw new Error("Failed to connect to game server");
      }
    } catch {
      console.error("[GAME CONTEXT] Error connecting to game server");
      gameStore.setGameState("error");
      return;
    }

    // 3. Wait for initial data and initialize anything that needs it
    await instanceManagerRef.current?.initialize();
    gameStore.setGameStateMessage(GameInitStateMessage.STARTING);

    console.debug("[GAME CONTEXT] Initialized, setting ready state");

    // 4. Set ready state and dispatch start event to bot
    gameStore.setGameStateMessage(GameInitStateMessage.READY);
    gameStore.setGameState("ready");

    // A little bit of air, so the bot starts talking after the visor opens
    await wait(1000);

    // 5. Dispatch start event to bot to kick off the conversation
    dispatchEvent({ type: "start" });
  }, [onConnect, gameStore, dispatchEvent, client]);

  /**
   * Handle server message
   */
  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (e: ServerMessage) => {
        if ("event" in e) {
          console.debug("[GAME EVENT] Server message received", e.event, e);

          // Transform server message tool call responses to normalized event messages
          // @TODO: remove this once game server changes
          const gameEvent = transformMessage(e);
          if (!gameEvent) {
            return;
          }

          switch (gameEvent.event) {
            // ----- STATUS
            case "status.snapshot":
            case "status.update": {
              console.debug("[GAME EVENT] Status update", gameEvent.payload);

              const status = gameEvent.payload as StatusMessage;

              // Update store
              gameStore.setState({
                player: status.player,
                ship: status.ship,
                sector: status.sector,
              });

              // Initialize game client if this is the first status update

              if (status.source?.method === "join") {
                gameStore.addActivityLogEntry({
                  type: "join",
                  message: "Joined the game",
                });
              }

              break;
            }

            // ----- CHARACTERS / NPCS
            case "character.moved": {
              console.debug("[GAME EVENT] Character moved", gameEvent.payload);
              const data = gameEvent.payload as CharacterMovedMessage;

              // Update sector contents with new player
              // @TODO: update to use new event shape when available
              const tempDataRemap: Player = {
                id: data.name,
                name: data.name,
                player_type: data.player_type ?? "npc",
                ship: {
                  ship_name: data.ship_type,
                  ship_type: data.ship_type,
                } as Ship,
              };

              if (data.movement === "arrive") {
                console.debug(
                  "[GAME EVENT] Adding player to sector",
                  gameEvent.payload
                );
                gameStore.addSectorPlayer(tempDataRemap);
              } else if (data.movement === "depart") {
                console.debug(
                  "[GAME EVENT] Removing player from sector",
                  gameEvent.payload
                );
                gameStore.removeSectorPlayer(tempDataRemap);
              } else {
                console.warn(
                  "[GAME EVENT] Unknown movement type",
                  data.movement
                );
              }

              break;
            }

            // ----- MOVEMENT
            case "movement.start": {
              console.debug("[GAME EVENT] Move started", gameEvent.payload);

              startMoveToSector(
                (gameEvent.payload as MovementStartMessage).sector
              );
              break;
            }

            case "movement.complete": {
              console.debug("[GAME EVENT] Move completed", gameEvent.payload);
              const data = gameEvent.payload as MovementCompleteMessage;

              // Update ship and player
              // This hydrates things like warp power, player last active, etc.
              gameStore.setState({
                ship: data.ship,
                player: data.player,
              });

              // Add entry to movement history
              gameStore.addMovementHistory({
                from: gameStore.sector?.id ?? 0,
                to: gameStore.sectorBuffer?.id ?? 0,
                port: !!gameStore.sectorBuffer?.port,
              });

              // Update activity log
              // @TODO: optimize but having movement history and activity log index same data
              gameStore.addActivityLogEntry({
                type: "movement",
                message: `Moved from sector ${gameStore.sector?.id} to sector ${gameStore.sectorBuffer?.id}`,
              });
              // If this is our first time here, update log with discovery

              // Swap in the buffered sector
              // Note: Starfield instance already in sync through animation sequencing
              if (gameStore.sectorBuffer) {
                gameStore.setSector(gameStore.sectorBuffer as Sector);
              }

              gameStore.setUIState("idle");

              // Cleanup

              // Remove any course plot data if we've reached out intended destination
              // @TODO: make this logic robust (plots should become stale after a certain time)
              if (
                gameStore.course_plot?.to_sector === gameStore.sectorBuffer?.id
              ) {
                console.debug(
                  "[GAME EVENT] Reached intended destination, clearing course plot"
                );
                gameStore.clearCoursePlot();
              }
              // Remove active course plot if we've gone to a sector outside of the plot
              if (
                gameStore.sectorBuffer?.id &&
                !gameStore.course_plot?.path.includes(
                  gameStore.sectorBuffer?.id ?? 0
                )
              ) {
                console.debug(
                  "[GAME EVENT] Went to a sector outside of the plot, clearing course plot"
                );
                gameStore.clearCoursePlot();
              }
              break;
            }

            case "bank.transaction": {
              console.debug("[GAME EVENT] Deposit", gameEvent.payload);
              const data = gameEvent.payload as BankTransactionMessage;

              // Note: we do not need to update the player or ship state
              // as status.update is dispatched immediately after

              if (data.direction === "deposit") {
                gameStore.addActivityLogEntry({
                  type: "bank.transaction",
                  message: `Deposited [${data.amount}] credits to bank`,
                });
              } else {
                gameStore.addActivityLogEntry({
                  type: "bank.transaction",
                  message: `Withdrew [${data.amount}] credits from bank`,
                });
              }
              break;
            }

            // ----- MAP

            case "sector.update": {
              console.debug("[GAME EVENT] Sector update", gameEvent.payload);
              const data = gameEvent.payload as SectorUpdateMessage;

              gameStore.setSector(data as Sector);

              // Note: not updating activity log as redundant from other logs

              //gameStore.addActivityLogEntry({
              //  type: "sector.update",
              //  message: `Sector ${data.id} updated`,
              //});

              break;
            }

            case "salvage.created": {
              console.debug("[GAME EVENT] Salvage created", gameEvent.payload);
              const data = gameEvent.payload as SalvageCreatedMessage;

              // Note: we update sector contents in proceeding sector.update event

              // @TODO: status update is missing, so we may need to update player state here

              gameStore.addActivityLogEntry({
                type: "salvage.created",
                message: `Salvage created in sector ${data.sector.id}`,
              });
              break;
            }

            case "salvage.collected": {
              console.debug("[GAME EVENT] Salvage claimed", gameEvent.payload);
              const data = gameEvent.payload as SalvageCollectedMessage;

              // @TODO: ideally we would defer to a status update
              // for now we'll use the event payload data
              const cargoClaimed = Object.fromEntries(
                Object.keys(RESOURCE_SHORT_NAMES).map((key) => [key, 0])
              ) as Record<Resource, number>;
              if (data.cargo_after) {
                for (const [key, value] of Object.entries(
                  data.collected.cargo
                )) {
                  cargoClaimed[key as Resource] = value;
                }
                gameStore.setShip({
                  cargo: data.cargo_after,
                });

                const claimedItems = Object.entries(cargoClaimed)
                  .filter((entry) => entry[1] > 0)
                  .map(
                    ([resource, amount]) =>
                      `[${
                        RESOURCE_SHORT_NAMES[resource as Resource]
                      }: ${amount}]`
                  )
                  .join(" ");

                gameStore.addActivityLogEntry({
                  type: "salvage.claimed",
                  message: `Salvage resources claimed: ${claimedItems}`,
                });
              }

              if (data.credits_after && data.credits_after > 0) {
                gameStore.setPlayer({
                  credits_on_hand: data.credits_after,
                });

                gameStore.addActivityLogEntry({
                  type: "salvage.claimed",
                  message: `Salvage credits claimed: ${data.credits_after}`,
                });
              }
              // @EOF: TODO

              break;
            }

            case "course.plot": {
              console.debug("[GAME EVENT] Course plot", gameEvent.payload);
              const data = gameEvent.payload as CoursePlotMessage;

              gameStore.setCoursePlot(data);
              break;
            }

            case "map.region":
            case "map.local": {
              console.debug("[GAME EVENT] Local map data", gameEvent.payload);

              // Compare new and current map data to "discover" and newly visited sector
              // @TODO: better handled by game-server, so placeholder for now
              const newSectors = checkForNewSectors(
                gameStore.local_map_data ?? null,
                (gameEvent.payload as MapLocalMessage).sectors
              );

              if (newSectors.length > 0) {
                console.log(
                  `[GAME EVENT] Discovered ${newSectors.length} new sectors!`,
                  newSectors
                );

                newSectors.forEach((sector) => {
                  gameStore.addActivityLogEntry({
                    type: "map.sector.discovered",
                    message: `Discovered sector ${sector.id}`,
                  });
                });
              }

              gameStore.setLocalMapData(
                (gameEvent.payload as MapLocalMessage).sectors
              );
              break;
            }

            // ----- TRADING & COMMERCE

            case "port.update": {
              console.debug("[GAME EVENT] Port update", gameEvent.payload);
              const data = gameEvent.payload as PortUpdateMessage;

              // If update is for current sector, update port payload
              gameStore.updateSector(data.sector);

              break;
            }

            case "ports.list": {
              console.debug("[GAME EVENT] Port list", gameEvent.payload);
              // @TODO: implement - waiting on shape of event to align to schema
              //const data = gameEvent.payload as KnownPortListMessage;
              //gameStore.setKnownPorts(data.ports);
              break;
            }

            case "warp.purchase": {
              console.debug("[GAME EVENT] Warp purchase", gameEvent.payload);
              const data = gameEvent.payload as WarpPurchaseMessage;

              // Largely a noop as status.update is dispatched immediately after
              // warp purchase. We just update activity log here for now.

              gameStore.addActivityLogEntry({
                type: "warp.purchase",
                message: `Purchased [${data.units}] warp units for [${data.total_cost}] credits`,
              });
              break;
            }

            case "warp.transfer": {
              console.debug("[GAME EVENT] Warp transfer", gameEvent.payload);
              const data = gameEvent.payload as WarpTransferMessage;

              let message = "";
              if (data.from_character_id === gameStore.player?.id) {
                message = `Transferred [${data.units}] warp units to [${data.to_character_id}]`;
              } else {
                message = `Received [${data.units}] warp units from [${data.from_character_id}]`;
              }

              gameStore.addActivityLogEntry({
                type: "warp.transfer",
                message: message,
              });
              break;
            }

            case "credits.transfer": {
              console.debug("[GAME EVENT] Credits transfer", gameEvent.payload);
              const data = gameEvent.payload as CreditsTransferMessage;

              // Note: we do not need to update the player or ship state
              // as status.update is dispatched immediately after

              const send_or_receive =
                data.from_character_id === gameStore.player?.id;
              const message = `${send_or_receive ? "Sent" : "Received"} [${
                data.amount
              }] credits ${send_or_receive ? "to" : "from"} [${
                data.to_character_id
              }]`;
              gameStore.addActivityLogEntry({
                type: "credits.transfer",
                message: message,
              });

              break;
            }

            // ----- COMBAT

            // ----- MISC

            case "chat.message": {
              console.debug("[GAME EVENT] Chat message", gameEvent.payload);
              const data = gameEvent.payload as IncomingChatMessage;

              gameStore.addMessage(data);
              gameStore.setNotifications({ newChatMessage: true });
              break;
            }

            case "error": {
              console.debug("[GAME EVENT] Error", gameEvent.payload);
              const data = gameEvent.payload as ErrorMessage;

              // @TODO: keep tabs on errors in separate store

              gameStore.addActivityLogEntry({
                type: "error",
                message: `Ship Protocol Failure: ${
                  data.endpoint ?? "Unknown"
                } - ${data.error}`,
              });
              break;
            }

            // ----- UNHANDLED :(
            default:
              console.warn(
                "[GAME EVENT] Unhandled server action:",
                gameEvent.event,
                gameEvent.payload
              );
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
  );

  return (
    <GameContext.Provider
      value={{ sendUserTextInput, dispatchEvent, initialize }}
    >
      {children}
    </GameContext.Provider>
  );
}
