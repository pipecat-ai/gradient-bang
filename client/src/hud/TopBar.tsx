import { CargoBadge } from "@/components/CargoBadge";
import { CargoHoldsBadge } from "@/components/CargoHoldsBadge";
import { CreditsOnHandBadge } from "@/components/CreditsOnHandBadge";
import { FightersBadge } from "@/components/FightersBadge";
import { DotDivider } from "@/components/primitives/DotDivider";
import { Separator } from "@/components/primitives/Separator";
import { ShieldsBadge } from "@/components/ShieldsBadge";
import { WarpBadge } from "@/components/WarpBadge";
import { ScreenMenu } from "@/screens/ScreenMenu";

export const TopBar = () => {
  return (
    <header className="flex flex-row justify-between gap-5">
      <div className="flex-1 p-ui-sm align-self max-w-100">
        <div className="elbow flex flex-col gap-1 p-2 backdrop-blur-sm bg-card/20">
          <WarpBadge />
          <Separator
            variant="dotted"
            className="w-full text-white/20 h-[8px]"
          />
          <div className="flex flex-row gap-1">
            <ShieldsBadge className="flex-1" />
            <FightersBadge className="flex-1" />
          </div>
        </div>
      </div>
      <div className="flex flex-row gap-2 justify-center">
        <ScreenMenu />
      </div>
      <div className="flex-1 p-ui-sm align-self max-w-100">
        <div className="elbow flex flex-col gap-1 p-2 backdrop-blur-sm bg-card/20">
          <CargoBadge />
          <Separator
            variant="dotted"
            className="w-full text-white/20 h-[8px]"
          />
          <div className="flex flex-row gap-1 items-center">
            <CargoHoldsBadge />
            <DotDivider />
            <CreditsOnHandBadge className="flex-1" />
          </div>
        </div>
      </div>
    </header>
  );
};
