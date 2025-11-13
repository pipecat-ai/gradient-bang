import {
  NeuroSymbolicsIcon,
  QuantumFoamIcon,
  RetroOrganicsIcon,
} from "@/icons";
import { RESOURCE_SHORT_NAMES } from "@/types/constants";
import type { Toast } from "@/types/toasts";
import { wait } from "@/utils/animation";
import { cn } from "@/utils/tailwind";
import { CoinVerticalIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { CurrencyCounter } from "../CurrencyCounter";
import { Card, CardContent } from "../primitives/Card";
import { Separator } from "../primitives/Separator";
import {
  ToastBase,
  ToastResourceTile,
  ToastTitle,
  ToastValue,
} from "./ToastBase";

interface TradeExecutedToastProps {
  toast: Toast & { type: "trade.executed" };
  onAnimateIn?: () => void;
  onAnimationComplete?: () => void;
  onDismiss?: () => void;
}

export const TradeExecutedToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: TradeExecutedToastProps) => {
  const { meta } = toast;
  const [credits, setCredits] = useState(meta?.old_credits ?? 0);

  useEffect(() => {
    wait(500).then(() => {
      setCredits(meta?.new_credits ?? 0);
    });
  }, [meta]);

  return (
    <ToastBase
      onAnimateIn={onAnimateIn}
      onAnimationComplete={onAnimationComplete}
      onClick={onDismiss}
    >
      <Card
        variant="stripes"
        size="sm"
        className="stripe-frame-white/30 stripe-frame-2 stripe-frame-size-2 border-none bg-transparent w-full h-full"
      >
        <CardContent className="flex flex-col h-full justify-between items-center gap-ui-sm">
          <ToastTitle>
            {meta?.trade_type === "buy" ? "Purchase Executed" : "Sale Executed"}
          </ToastTitle>
          <div className="flex flex-row gap-3 w-full h-full">
            <div className="flex flex-row gap-1.5 w-full h-full">
              <ToastResourceTile
                color={meta?.trade_type === "buy" ? "success" : "warning"}
                active={meta?.commodity === "quantum_foam"}
                commodity={RESOURCE_SHORT_NAMES["quantum_foam"]}
                units={
                  meta?.trade_type === "sell" &&
                  meta?.commodity === "quantum_foam"
                    ? meta?.units
                    : meta?.new_cargo.quantum_foam
                }
                prefix={
                  meta?.commodity === "quantum_foam" &&
                  meta?.trade_type === "sell"
                    ? "-"
                    : meta?.commodity === "quantum_foam" &&
                      meta?.trade_type === "buy"
                    ? "+"
                    : ""
                }
              >
                <QuantumFoamIcon
                  size={24}
                  weight="duotone"
                  className="shrink-0 size-6"
                />
              </ToastResourceTile>
              <ToastResourceTile
                color={meta?.trade_type === "buy" ? "success" : "warning"}
                active={meta?.commodity === "retro_organics"}
                commodity={RESOURCE_SHORT_NAMES["retro_organics"]}
                units={
                  meta?.trade_type === "sell" &&
                  meta?.commodity === "retro_organics"
                    ? meta?.units
                    : meta?.new_cargo.retro_organics
                }
                prefix={
                  meta?.commodity === "retro_organics" &&
                  meta?.trade_type === "sell"
                    ? "-"
                    : meta?.commodity === "retro_organics" &&
                      meta?.trade_type === "buy"
                    ? "+"
                    : ""
                }
              >
                <RetroOrganicsIcon
                  size={24}
                  weight="duotone"
                  className="shrink-0 size-6"
                />
              </ToastResourceTile>

              <ToastResourceTile
                color={meta?.trade_type === "buy" ? "success" : "warning"}
                active={meta?.commodity === "neuro_symbolics"}
                commodity={RESOURCE_SHORT_NAMES["neuro_symbolics"]}
                units={
                  meta?.trade_type === "sell" &&
                  meta?.commodity === "neuro_symbolics"
                    ? meta?.units
                    : meta?.new_cargo.neuro_symbolics
                }
                prefix={
                  meta?.trade_type === "buy"
                    ? "+"
                    : meta?.commodity === "neuro_symbolics"
                    ? "-"
                    : ""
                }
              >
                <NeuroSymbolicsIcon
                  size={24}
                  weight="duotone"
                  className="shrink-0 size-6"
                />
              </ToastResourceTile>
            </div>
            <Separator orientation="vertical" className="opacity-30" />
            <div className="flex flex-col gap-2 w-1/2">
              <div className="elbow elbow-1 elbow-size-4 elbow-border elbow-offset-0 p-1 text-center w-full text-xs font-bold uppercase bg-black/20">
                {meta?.price_per_unit}{" "}
                <span className="opacity-50">per unit</span>
              </div>
              <ToastValue className="flex-1 w-full">
                <CoinVerticalIcon weight="duotone" className="size-4" />
                <CurrencyCounter value={credits ?? 0} />
                <span
                  className={cn(
                    "text-xs font-medium animate-in fade-in-0 duration-1000",
                    meta?.trade_type === "buy" ? "text-warning" : "text-success"
                  )}
                >
                  {meta?.trade_type === "buy" ? "-" : "+"}
                  {meta?.total_price ?? 0}
                </span>
              </ToastValue>
            </div>
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  );
};
