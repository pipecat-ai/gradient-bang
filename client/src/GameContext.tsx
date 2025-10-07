import { RTVIEvent } from "@pipecat-ai/client-js";
import { usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react";
import useGameStore from "@stores/game";
import { createContext, useCallback, type ReactNode } from "react";

import { moveToSector, startMoveToSector } from "@/actions";

/**
 * Server message interfaces
 */
interface ServerMessage {
  event: string;
  payload: unknown;

  summary?: string;
  tool_name?: string;
}

interface StatusMessage {
  player: PlayerSelf;
  ship: ShipSelf;
  sector: Sector;
}

interface MovementStartMessage {
  sector: Sector;
  hyperspace_time: number;
}

interface MovementCompleteMessage {
  ship: ShipSelf;
  player: PlayerSelf;
}

interface MapLocalMessage {
  sectors: MapData;
  center_sector: number;
  total_sectors: number;
  total_unvisited: number;
  total_visited: number;
}

/**
 * Game context
 */
interface GameContextProps {
  sendUserTextInput: (text: string) => void;
}

const GameContext = createContext<GameContextProps>({
  sendUserTextInput: () => {},
});

interface GameProviderProps {
  children: ReactNode;
}

const transformMessage = (e: ServerMessage): ServerMessage | undefined => {
  if (
    ["tool_result", "tool_call", "task_output", "task_complete"].includes(
      e.event
    )
  ) {
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

export function GameProvider({ children }: GameProviderProps) {
  const gameStore = useGameStore();
  const client = usePipecatClient();

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
            case "status.update": {
              console.debug("[GAME EVENT] Status update", gameEvent.payload);

              const status = gameEvent.payload as StatusMessage;
              const initalizing = gameStore.sector === undefined;

              // Update store
              gameStore.setState({
                player: status.player,
                ship: status.ship,
                sector: status.sector,
              });

              // Update starfield by triggering a warp
              moveToSector(status.sector, !!initalizing);

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

              // Swap in the buffered sector
              // Note: Starfield instance should already be in sync
              if (gameStore.sectorBuffer) {
                gameStore.setSector(gameStore.sectorBuffer as Sector);
              }

              gameStore.setUIState("idle");
              break;
            }

            case "map.local": {
              console.debug("[GAME EVENT] Local map data", gameEvent.payload);
              // For now, we only store the map data
              // @TODO: implement proper slice
              gameStore.setLocalMapData(
                (gameEvent.payload as MapLocalMessage).sectors
              );
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
    <GameContext.Provider value={{ sendUserTextInput }}>
      {children}
    </GameContext.Provider>
  );
}

export { GameContext };
