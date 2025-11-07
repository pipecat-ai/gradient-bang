import { Badge } from "@/components/primitives/Badge";
import useGameStore from "@/stores/game";

export const PortBadge = () => {
  const sector = useGameStore.use.sector?.();
  const isAtPort = sector?.id === 0 || sector?.port;
  const isMegaPort = sector?.id === 0;

  return (
    <Badge
      border="bracket"
      className={
        isAtPort
          ? "flex-1 elbow elbow-offset-4 elbow-size-12 elbow-fuel/60 elbow- bracket-3"
          : "flex-1 text-white/40 bg-black bracket-offset-0"
      }
      variant={isAtPort ? "highlight" : "secondary"}
    >
      {isMegaPort
        ? "Mega Port"
        : isAtPort
        ? `Port ${sector?.port?.code}`
        : "No Port"}
    </Badge>
  );
};
