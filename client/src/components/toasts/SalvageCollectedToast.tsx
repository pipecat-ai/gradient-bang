import {
  CreditsIcon,
  NeuroSymbolicsIcon,
  QuantumFoamIcon,
  RetroOrganicsIcon,
  ScrapIcon,
} from "@/icons";
import { RESOURCE_SHORT_NAMES } from "@/types/constants";
import type { Toast } from "@/types/toasts";
import { Card, CardContent } from "../primitives/Card";
import { Separator } from "../primitives/Separator";
import { ToastBase, ToastResourceTile, ToastTitle } from "./ToastBase";

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
              active={!!meta?.salvage.collected?.cargo?.quantum_foam}
              commodity={RESOURCE_SHORT_NAMES["quantum_foam"]}
              units={meta?.salvage.collected?.cargo?.quantum_foam}
            >
              <QuantumFoamIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
            <ToastResourceTile
              active={!!meta?.salvage.collected?.cargo?.retro_organics}
              commodity={RESOURCE_SHORT_NAMES["retro_organics"]}
              units={meta?.salvage.collected?.cargo?.retro_organics}
            >
              <RetroOrganicsIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
            <ToastResourceTile
              active={!!meta?.salvage.collected?.cargo?.neuro_symbolics}
              commodity={RESOURCE_SHORT_NAMES["neuro_symbolics"]}
              units={meta?.salvage.collected?.cargo?.neuro_symbolics}
            >
              <NeuroSymbolicsIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
            <Separator orientation="vertical" className="opacity-50 mx-1" />
            <ToastResourceTile
              active={!!meta?.salvage.collected?.credits}
              commodity="cr"
              units={meta?.salvage.collected?.credits}
            >
              <CreditsIcon
                size={24}
                weight="duotone"
                className="shrink-0 size-6"
              />
            </ToastResourceTile>
            <Separator orientation="vertical" className="opacity-50 mx-1" />
            <ToastResourceTile
              active={!!meta?.salvage.collected?.scrap}
              commodity="Scrap"
              units={meta?.salvage.collected?.scrap}
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
