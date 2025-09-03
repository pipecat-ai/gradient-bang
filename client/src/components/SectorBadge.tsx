import { Badge } from "@pipecat-ai/voice-ui-kit";
import useSectorStore from "../stores/sector";

export const SectorBadge = () => {
  const { sector } = useSectorStore();

  return (
    <Badge variant="bracket" className="flex-1" size="lg">
      Sector:
      <span
        className={
          sector !== null ? "opacity-100 font-extrabold" : "opacity-40"
        }
      >
        {sector ?? "unknown"}
      </span>
    </Badge>
  );
};
