import { Badge, BadgeTitle } from "@/components/primitives/Badge";

import { cn } from "@/utils/tailwind";
import useGameStore from "../stores/game";

export const CargoHoldsBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  const formatCargo = (value: number) => value.toString().padStart(3, "0");

  return (
    <div className={cn("flex flex-row gap-1 items-center", className)}>
      <Badge variant="glass" border="elbow" className="gap-1">
        <BadgeTitle>QF:</BadgeTitle>
        <BadgeTitle
          className={cn(
            ship?.cargo?.quantum_foam ?? 0 > 0 ? "opacity-100" : "opacity-50"
          )}
        >
          {formatCargo(ship?.cargo?.quantum_foam ?? 0)}
        </BadgeTitle>
      </Badge>
      <Badge variant="glass" border="elbow" className="gap-1">
        <BadgeTitle>RO:</BadgeTitle>
        <BadgeTitle
          className={cn(
            ship?.cargo?.retro_organics ?? 0 > 0 ? "opacity-100" : "opacity-50"
          )}
        >
          {formatCargo(ship?.cargo?.retro_organics ?? 0)}
        </BadgeTitle>
      </Badge>
      <Badge variant="glass" border="elbow" className="gap-1">
        <BadgeTitle>NS:</BadgeTitle>
        <BadgeTitle
          className={cn(
            ship?.cargo?.neuro_symbolics ?? 0 > 0 ? "opacity-100" : "opacity-50"
          )}
        >
          {formatCargo(ship?.cargo?.neuro_symbolics ?? 0)}
        </BadgeTitle>
      </Badge>
    </div>
  );
};
