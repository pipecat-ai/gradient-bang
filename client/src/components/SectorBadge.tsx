import { Badge } from "@pipecat-ai/voice-ui-kit";
import useGameStore from "../stores/game";

export const SectorBadge = () => {
  const sector = useGameStore.use.sector();

  return (
    <Badge variant="bracket" className="flex-1" size="lg">
      Sector:
      <span
        className={
          sector?.id !== undefined ? "opacity-100 font-extrabold" : "opacity-40"
        }
      >
        {sector?.id ?? "unknown"}
      </span>
    </Badge>
  );
};
