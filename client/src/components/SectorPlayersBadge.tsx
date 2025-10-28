import useGameStore from "@/stores/game";
import { NumericalBadge } from "./NumericalBadge";

export const SectorPlayersBadge = () => {
  const sector = useGameStore.use.sector?.();

  const players = sector?.players;

  console.log("PEW", players);

  return (
    <NumericalBadge value={players?.length ?? 0} formatAsCurrency={false}>
      Players:
    </NumericalBadge>
  );
};
