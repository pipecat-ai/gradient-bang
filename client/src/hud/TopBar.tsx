import { NumericalBadge } from "@/components/NumericalBadge";
import { WarpBadge } from "@/components/WarpBadge";
import { ScreenMenu } from "@/screens/ScreenMenu";
import {
  CurrencyCircleDollarIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import { Button } from "@pipecat-ai/voice-ui-kit";
import useGameStore from "@stores/game";

export const TopBar = () => {
  const player = useGameStore.use.player();
  const setActiveModal = useGameStore.use.setActiveModal();

  return (
    <header className="flex flex-row justify-between items-center px-ui-md">
      <div className="flex flex-row gap-4 flex-1">
        <WarpBadge />
      </div>
      <div className="flex flex-row gap-2 items-center">
        <ScreenMenu />
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
