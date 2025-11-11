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
import { ToastBase, ToastTitle, ToastValue } from "./ToastBase";

interface TradeExecutedToastProps {
  toast: Toast & { type: "trade.executed" };
  onAnimateIn?: () => void;
  onAnimationComplete?: () => void;
  onDismiss?: () => void;
}

const TradeCommodityItem = ({
  children,
  active = false,
  commodity,
  units,
}: {
  children: React.ReactNode;
  active: boolean;
  commodity: Resource;
  units?: number;
}) => {
  return (
    <div
      className={cn(
        "flex flex-col border items-center justify-center flex-1",
        !active
          ? "opacity-50 cross-lines-accent border-border"
          : "border-success"
      )}
    >
      <div className="flex items-center justify-center h-full">{children}</div>
      <div className="bg-black w-full text-center text-xs font-bold py-1">
        {RESOURCE_SHORT_NAMES[commodity]}:{" "}
        <span className={units === 0 ? "opacity-50" : "text-success"}>
          {units || 0}
        </span>
      </div>
    </div>
  );
};
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
        <CardContent className="flex flex-col h-full justify-between items-center gap-3">
          <ToastTitle>
            {meta?.trade_type === "buy" ? "Purchase Executed" : "Sale Executed"}
          </ToastTitle>
          <div className="flex flex-row gap-3 w-full h-full">
            <div className="flex flex-row gap-1.5 w-full h-full">
              <TradeCommodityItem
                active={meta?.commodity === "quantum_foam"}
                commodity="quantum_foam"
                units={meta?.new_cargo.quantum_foam}
              >
                <QuantumFoamIcon
                  size={24}
                  weight="duotone"
                  className="shrink-0 size-6"
                />
              </TradeCommodityItem>
              <TradeCommodityItem
                active={meta?.commodity === "retro_organics"}
                commodity="retro_organics"
                units={meta?.new_cargo.retro_organics}
              >
                <RetroOrganicsIcon
                  size={24}
                  weight="duotone"
                  className="shrink-0 size-6"
                />
              </TradeCommodityItem>

              <TradeCommodityItem
                active={meta?.commodity === "neuro_symbolics"}
                commodity="neuro_symbolics"
                units={meta?.new_cargo.neuro_symbolics}
              >
                <NeuroSymbolicsIcon
                  size={24}
                  weight="duotone"
                  className="shrink-0 size-6"
                />
              </TradeCommodityItem>
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
