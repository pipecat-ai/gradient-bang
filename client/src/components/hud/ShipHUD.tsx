import { LHS } from "@hud/LHS";
import { RHS } from "@hud/RHS";

export const ShipHUD = () => {
  return (
    <div className="flex flex-row p-ui-sm h-ui mt-auto gap-2 z-(--z-hud) justify-between">
      <LHS />
      <RHS />
    </div>
  );
};
