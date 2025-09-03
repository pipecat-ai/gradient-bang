import { RTVIEvent, type TransportState } from "@pipecat-ai/client-js";
import { usePipecatClient, useRTVIClientEvent } from "@pipecat-ai/client-react";
import { Badge, Button } from "@pipecat-ai/voice-ui-kit";
import { XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { useGameManager } from "../hooks/useGameManager";
import useStarfieldStore from "../stores/starfield";
import { DotDivider } from "./primitives/DotDivider";
import { WarpBadge } from "./WarpBadge";

export const Footer = () => {
  const { game, getAllCargo } = useGameManager();
  const { getInstance } = useStarfieldStore();
  const client = usePipecatClient();
  const [transportState, setTransportState] =
    useState<TransportState>("disconnected");

  useRTVIClientEvent(RTVIEvent.TransportStateChanged, (newState) => {
    setTransportState(newState);
  });

  const statusBadgeProps = useCallback(() => {
    let props = {
      color: "secondary",
      variant: "bracket",
      className: "",
    };
    switch (transportState) {
      case "disconnected":
      case "initialized":
      case "initializing":
        props = {
          color: "secondary",
          variant: "bracket",
          className: "",
        };
        break;
      case "authenticating":
      case "authenticated":
      case "connecting":
        props = {
          color: "warning",
          variant: "bracket",
          className: "animate-pulse",
        };
        break;
      default:
        props = {
          color: "active",
          variant: "bracket",
          className: "",
        };
        break;
    }
    return props;
  }, [transportState]);

  return (
    <footer className="flex flex-row p-panel justify-between items-center border-t text-sm bg-card">
      <div className="flex flex-row gap-4">
        <div className="flex flex-row gap-2 items-center">
          <span className="font-bold">Ship:</span>
          <div className="flex flex-row gap-2 items-center">
            <span className={game.ship ? "opacity-100" : "opacity-40"}>
              {game.ship?.ship_name ?? "Unknown"}
            </span>
          </div>
        </div>
        <div className="flex flex-row gap-2 items-center">
          <span className="font-bold">Warp:</span>
          <WarpBadge />
        </div>
      </div>
      <div className="flex flex-row gap-2 items-center">
        <Badge size="md" variant="elbow" color="primary">
          $ Credits:{" "}
          <span
            className={
              game.ship?.credits && game.ship.credits > 0
                ? "opacity-100"
                : "opacity-40"
            }
          >
            {game?.ship?.credits ? game.ship?.credits?.toLocaleString() : "---"}
          </span>
        </Badge>
        <DotDivider />
        {Object.entries(getAllCargo()).map(([resource, amount]) => (
          <Badge key={resource} size="md" variant="elbow" color="primary">
            {resource.charAt(0).toUpperCase() + resource.slice(1)}:{" "}
            <span
              className={amount && amount > 0 ? "opacity-100" : "opacity-40"}
            >
              {amount}
            </span>
          </Badge>
        ))}
        <DotDivider />
        <Badge size="md" variant="elbow" color="primary">
          Capacity:{" "}
          <span className={game.ship ? "opacity-100" : "opacity-40"}>
            {game.ship?.cargo_capacity ?? "---"}
          </span>
        </Badge>
      </div>
      <div className="flex flex-row gap-4">
        <Badge {...statusBadgeProps()}>Status: {transportState}</Badge>
        <Badge
          color="secondary"
          variant="elbow"
          onClick={() => {
            if (["connected", "ready"].includes(transportState)) {
              client?.disconnect();
            }
          }}
          className={
            ["connected", "ready"].includes(transportState)
              ? "opacity-100 hover:text-amber-500 cursor-pointer user-select-none"
              : "opacity-40"
          }
        >
          <XIcon size={20} />
          Eject
        </Badge>
        <Button
          size="sm"
          onClick={() => {
            const instance = getInstance();
            if (instance) {
              console.log(instance.logConfig());
            }
          }}
        >
          Log config
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const instance = getInstance();
            if (!instance) return;
            instance.warpToSector({
              id: "1",
              gameObjects: [
                {
                  id: "port_1",
                  type: "port",
                  name: "Port",
                },
              ],
            });
          }}
        >
          Warp to sector 1
        </Button>
      </div>
    </footer>
  );
};
