import { Badge, BadgeTitle } from "@/components/primitives/Badge";

import { cn } from "@/utils/tailwind";
import { CoinVerticalIcon } from "@phosphor-icons/react";
import useGameStore from "../stores/game";

export const CreditsOnHandBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  return (
    <Badge
      variant="glass"
      border="elbow"
      className={cn("gap-1 justify-between", className)}
    >
      <BadgeTitle>
        <CoinVerticalIcon weight="duotone" className="size-4" />
      </BadgeTitle>
      <BadgeTitle>{ship?.credits ?? 0}</BadgeTitle>
    </Badge>
  );
};
