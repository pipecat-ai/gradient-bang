import { cn } from "@/utils/tailwind";
import useGameStore from "@stores/game";
import { CargoResourceBadge } from "./CargoResourceBadge";

export const CargoHoldsBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  return (
    <div className={cn("flex flex-row gap-1 items-center", className)}>
      <CargoResourceBadge
        resource="quantum_foam"
        value={ship?.cargo?.quantum_foam ?? 0}
      />
      <CargoResourceBadge
        resource="retro_organics"
        value={ship?.cargo?.retro_organics ?? 0}
      />
      <CargoResourceBadge
        resource="neuro_symbolics"
        value={ship?.cargo?.neuro_symbolics ?? 0}
      />
    </div>
  );
};
