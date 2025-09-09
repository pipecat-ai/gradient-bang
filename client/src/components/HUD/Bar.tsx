import { CurrencyCircleDollarIcon } from "@phosphor-icons/react";
import { useGameManager } from "../../hooks/useGameManager";
import { CargoCapacityBadge } from "../CargoCapacityBadge";
import { NumericalBadge } from "../NumericalBadge";
import { DotDivider } from "../primitives/DotDivider";
import { WarpBadge } from "./../WarpBadge";

export const Bar = () => {
  const { game } = useGameManager();

  const fuelOre = game.ship?.cargo.fuel_ore;
  const organics = game.ship?.cargo.organics;
  const equipment = game.ship?.cargo.equipment;

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
        <NumericalBadge value={game.ship?.credits} formatAsCurrency={true}>
          <CurrencyCircleDollarIcon weight="duotone" className="size-5 mr-1" />{" "}
          Credits:
        </NumericalBadge>
        {/*<Button
          size="sm"
          onClick={() => {
            const instance = getInstance();
            if (instance) {
              instance.startWarp();
            }
          }}
        >
          Warp
        </Button>*/}
      </div>
    </footer>
  );
};
