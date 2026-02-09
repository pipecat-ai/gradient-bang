import {
  CreditsIcon,
  NeuroSymbolicsIcon,
  QuantumFoamIcon,
  RetroOrganicsIcon,
  ScrapIcon,
} from "@/icons";

import { Card, CardContent } from "../primitives/Card";
import { Separator } from "../primitives/Separator";
import { ToastBase, ToastResourceTile, ToastTitle } from "./ToastBase";

import { RESOURCE_SHORT_NAMES } from "@/types/constants";
import type { Toast } from "@/types/toasts";

interface SalvageCollectedToastProps {
  toast: Toast & { type: "salvage.collected" };
  onAnimateIn?: () => void;
  onAnimationComplete?: () => void;
  onDismiss?: () => void;
}

export const SalvageCollectedToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: SalvageCollectedToastProps) => {
  const { meta } = toast;
  const collected = meta?.salvage?.collected;
  const cargo = collected?.cargo;
  const credits = collected?.credits;
  const scrap = collected?.scrap;

  return (
    <ToastBase
      onAnimateIn={onAnimateIn}
      onAnimationComplete={onAnimationComplete}
      onClick={onDismiss}
    >
      <Card
        variant="stripes"
        size="sm"
        className="stripe-frame-success/30 stripe-frame-2 stripe-frame-size-2 border-none bg-transparent w-full h-full"
      >
        <CardContent className="flex flex-col h-full justify-between items-center gap-ui-sm">
          <ToastTitle>
            Salvage <span className="text-success">Collected</span>
          </ToastTitle>
          <div className="flex flex-row gap-1.5 w-full h-full">
            <ToastResourceTile
              active={!!cargo?.quantum_foam}
              commodity={RESOURCE_SHORT_NAMES["quantum_foam"]}
              units={cargo?.quantum_foam}
            >
              <QuantumFoamIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
            <ToastResourceTile
              active={!!cargo?.retro_organics}
              commodity={RESOURCE_SHORT_NAMES["retro_organics"]}
              units={cargo?.retro_organics}
            >
              <RetroOrganicsIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
            <ToastResourceTile
              active={!!cargo?.neuro_symbolics}
              commodity={RESOURCE_SHORT_NAMES["neuro_symbolics"]}
              units={cargo?.neuro_symbolics}
            >
              <NeuroSymbolicsIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
            <Separator orientation="vertical" className="opacity-50 mx-1" />
            <ToastResourceTile
              active={!!credits}
              commodity="cr"
              units={credits}
            >
              <CreditsIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
            <Separator orientation="vertical" className="opacity-50 mx-1" />
            <ToastResourceTile
              active={!!scrap}
              commodity="Scrap"
              units={scrap}
            >
              <ScrapIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  );
};
