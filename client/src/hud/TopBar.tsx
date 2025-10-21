import { CargoCapacityBadge } from "@/components/CargoCapacityBadge";
import { NumericalBadge } from "@/components/NumericalBadge";
import { DotDivider } from "@/components/primitives/DotDivider";
import { WarpBadge } from "@/components/WarpBadge";
import {
  CurrencyCircleDollarIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import { Button } from "@pipecat-ai/voice-ui-kit";
import useGameStore from "@stores/game";

export const TopBar = () => {
  const ship = useGameStore.use.ship();
  const player = useGameStore.use.player();
  const setActiveModal = useGameStore.use.setActiveModal();

  return (
    <header className="flex flex-row p-4 justify-between items-center ">
      <div className="flex flex-row gap-4 flex-1">
        <WarpBadge />
      </div>
      <div className="flex flex-row gap-2 items-center">
        <NumericalBadge value={ship?.cargo?.quantum_foam || 0}>
          QF:
        </NumericalBadge>
        <NumericalBadge value={ship?.cargo?.retro_organics || 0}>
          RO:
        </NumericalBadge>
        <NumericalBadge value={ship?.cargo?.neuro_symbolics || 0}>
          NS:
        </NumericalBadge>
        <DotDivider />
        <CargoCapacityBadge />
      </div>
      <div className="flex flex-row gap-4 flex-1 justify-end">
        <NumericalBadge value={player.credits_on_hand} formatAsCurrency={true}>
          <CurrencyCircleDollarIcon weight="duotone" className="size-5 mr-1" />{" "}
          Credits:
        </NumericalBadge>

        <Button
          isIcon
          variant="outline"
          onClick={() => setActiveModal("settings")}
        >
          <SlidersHorizontalIcon className="size-5" />
        </Button>
      </div>
    </header>
  );
};
