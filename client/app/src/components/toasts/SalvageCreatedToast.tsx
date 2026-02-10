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

interface SalvageCreatedToastProps {
  toast: Toast & { type: "salvage.created" };
  onAnimateIn?: () => void;
  onAnimationComplete?: () => void;
  onDismiss?: () => void;
}

export const SalvageCreatedToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: SalvageCreatedToastProps) => {
  const { meta } = toast;
  const salvage = meta?.salvage;
  const cargo = salvage?.cargo;
  const credits = salvage?.credits;
  const scrap = salvage?.scrap;

  return (
    <ToastBase
      onAnimateIn={onAnimateIn}
      onAnimationComplete={onAnimationComplete}
      onClick={onDismiss}
    >
      <Card
        variant="stripes"
        size="sm"
        className="stripe-frame-warning/30 stripe-frame-2 stripe-frame-size-2 border-none bg-transparent w-full h-full"
      >
        <CardContent className="flex flex-col h-full justify-between items-center gap-ui-sm">
          <ToastTitle>
            Salvage <span className="text-warning">Created</span>
          </ToastTitle>
          <div className="flex flex-row gap-1.5 w-full h-full">
            <ToastResourceTile
              color="warning"
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
              color="warning"
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
              color="warning"
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
              color="warning"
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
              color="warning"
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
