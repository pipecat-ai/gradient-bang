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

          switch (e.event) {
            // ----- STATUS
            case "status.update": {
              console.debug("[GAME EVENT] Status update", e.payload);

              const status = e.payload as StatusMessage;
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
              console.debug("[GAME EVENT] Move started", e.payload);

              startMoveToSector((e.payload as MovementStartMessage).sector);
              break;
            }

            case "movement.complete": {
              console.debug("[GAME EVENT] Move completed", e.payload);
              const data = e.payload as MovementCompleteMessage;

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
              console.debug("[GAME EVENT] Local map data", e.payload);
              // For now, we only store the map data
              // @TODO: implement proper slice
              gameStore.setLocalMapData((e.payload as MapLocalMessage).sectors);
              break;
            }

            // ----- UNHANDLED :(
            default:
              console.warn(
                "[GAME EVENT] Unhandled server action:",
                e.event,
                e.payload
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
