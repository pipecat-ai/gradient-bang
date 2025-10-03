import { CurrencyCircleDollarIcon } from "@phosphor-icons/react";
import { CargoCapacityBadge } from "../components/CargoCapacityBadge";
import { NumericalBadge } from "../components/NumericalBadge";
import { DotDivider } from "../components/primitives/DotDivider";
import { WarpBadge } from "../components/WarpBadge";
import useGameStore from "../stores/game";

export const TopBar = () => {
  const ship = useGameStore.use.ship();
  const credits = useGameStore.use.credits();

  const fuelOre = ship?.cargo.fuel_ore;
  const organics = ship?.cargo.organics;
  const equipment = ship?.cargo.equipment;

  return (
    <footer className="flex flex-row p-panel justify-between items-center">
      <div className="flex flex-row gap-4 flex-1">
        <WarpBadge />
      </div>
      <div className="flex flex-row gap-2 items-center">
        <NumericalBadge value={fuelOre}>FO:</NumericalBadge>
        <NumericalBadge value={organics}>OG:</NumericalBadge>
        <NumericalBadge value={equipment}>EQ:</NumericalBadge>
        <DotDivider />
        <CargoCapacityBadge />
      </div>
      <div className="flex flex-row gap-4 flex-1 justify-end">
        <NumericalBadge value={credits} formatAsCurrency={true}>
          <CurrencyCircleDollarIcon weight="duotone" className="size-5 mr-1" />{" "}
          Credits:
        </NumericalBadge>
      </div>
    </footer>
  );
};
