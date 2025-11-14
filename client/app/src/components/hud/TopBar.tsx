import { CargoBadge } from "@/components/CargoBadge";
import { CargoHoldsBadge } from "@/components/CargoHoldsBadge";
import { FightersBadge } from "@/components/FightersBadge";
import { Separator } from "@/components/primitives/Separator";
import { ScreenMenu } from "@/components/screens/ScreenMenu";
import { ShieldsBadge } from "@/components/ShieldsBadge";
import { WarpBadge } from "@/components/WarpBadge";

import { CreditsOnHandBadge } from "../CreditsOnHandBadge";
import { DotDivider } from "../primitives/DotDivider";

export const TopBar = () => {
  return (
    <header className="flex flex-row justify-between gap-5">
      <div className="flex-1 p-ui-sm align-self w-full max-w-110 top-lhs-perspective">
        <div className="elbow flex flex-col gap-1 p-2 bg-card/20 motion-safe:backdrop-blur-sm motion-safe:bg-card/10">
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
      <div className="flex-1 p-ui-sm align-self w-full max-w-110 top-rhs-perspective">
        <div className="elbow flex flex-col gap-1 p-2 bg-card/20 motion-safe:backdrop-blur-sm motion-safe:bg-card/10">
          <CargoBadge />
          <Separator
            variant="dotted"
            className="w-full text-white/20 h-[8px]"
          />
          <div className="flex flex-row gap-1 items-center">
            <CargoHoldsBadge />
            <DotDivider className="mx-1" />
            <CreditsOnHandBadge />
          </div>
        </div>
      </div>
    </header>
  );
};
