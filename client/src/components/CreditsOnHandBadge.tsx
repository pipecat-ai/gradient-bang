import { NumericalBadge } from "@/components/NumericalBadge";
import useGameStore from "@/stores/game";
import { cn } from "@/utils/tailwind";
import { CoinVerticalIcon } from "@phosphor-icons/react";

export const CreditsOnHandBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  return (
    <NumericalBadge
      border="elbow"
      value={ship?.credits ?? 0}
      formatAsCurrency={true}
      variant="count"
      variants={{
        increment: "countIncrement",
        decrement: "countDecrement",
      }}
      className={cn("gap-1 justify-between flex-1 text-right", className)}
      classNames={{
        value: "flex-1",
      }}
    >
      <CoinVerticalIcon weight="duotone" className="size-4" />
    </NumericalBadge>
  );
};
