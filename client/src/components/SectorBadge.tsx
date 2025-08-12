import { Badge } from "@pipecat-ai/voice-ui-kit";
import { useGameManager } from "../hooks/useGameManager";

export const SectorBadge = () => {
  const { game } = useGameManager();

  return (
    <Badge variant="bracket" color="primary" className="flex-1" size="lg">
      Sector:
      <span
        className={
          game.sector !== null ? "opacity-100 font-extrabold" : "opacity-40"
        }
      >
        {game.sector ?? "unknown"}
      </span>
    </Badge>
  );
};
