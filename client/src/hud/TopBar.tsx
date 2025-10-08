import { CurrencyCircleDollarIcon } from "@phosphor-icons/react";
import { Button } from "@pipecat-ai/voice-ui-kit";
import { CargoCapacityBadge } from "../components/CargoCapacityBadge";
import { NumericalBadge } from "../components/NumericalBadge";
import { DotDivider } from "../components/primitives/DotDivider";
import { WarpBadge } from "../components/WarpBadge";
import useGameStore from "../stores/game";

export const TopBar = () => {
  const ship = useGameStore.use.ship();
  const credits = useGameStore.use.player().credits;
  const setModal = useGameStore.use.setModal();

  return (
    <footer className="flex flex-row p-panel justify-between items-center">
      <div className="flex flex-row gap-4 flex-1">
        <WarpBadge />
      </div>
      <div className="flex flex-row gap-2 items-center">
        <NumericalBadge value={ship?.cargo?.FO || 0}>FO:</NumericalBadge>
        <NumericalBadge value={ship?.cargo?.OG || 0}>OG:</NumericalBadge>
        <NumericalBadge value={ship?.cargo?.EQ || 0}>EQ:</NumericalBadge>
        <DotDivider />
        <CargoCapacityBadge />
      </div>
      <div className="flex flex-row gap-4 flex-1 justify-end">
        <NumericalBadge value={credits} formatAsCurrency={true}>
          <CurrencyCircleDollarIcon weight="duotone" className="size-5 mr-1" />{" "}
          Credits:
        </NumericalBadge>

        <Button variant="secondary" onClick={() => setModal("settings")}>
          Pew
        </Button>
      </div>
    </footer>
  );
};
