import type { Toast } from "@/types/toasts";
import { wait } from "@/utils/animation";
import { CoinVerticalIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { CurrencyCounter } from "../CurrencyCounter";
import { Card, CardContent } from "../primitives/Card";
import { Progress } from "../primitives/Progress";
import { ToastBase, ToastTitle, ToastValue } from "./ToastBase";

interface FuelPurchasedToastProps {
  toast: Toast & { type: "warp.purchase" };
  onAnimateIn?: () => void;
  onAnimationComplete?: () => void;
  onDismiss?: () => void;
}
export const FuelPurchasedToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: FuelPurchasedToastProps) => {
  const { meta } = toast;
  const [newCredits, setNewCredits] = useState(meta?.prev_credits ?? 0);

  const [warpAmount, setWarpAmount] = useState(meta?.prev_amount ?? 0);

  useEffect(() => {
    wait(500).then(() => {
      setNewCredits(meta?.new_credits ?? 0);
      setWarpAmount(meta?.new_amount ?? 0);
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
        className="stripe-frame-fuel/30 stripe-frame-2 stripe-frame-size-2 border-none bg-transparent w-full h-full"
      >
        <CardContent className="flex flex-col h-full justify-between items-center">
          <ToastTitle>Warp Fuel Purchased</ToastTitle>

          <div className="elbow elbow-1 elbow-size-10 elbow-border elbow-offset-0 p-2 w-full">
            <Progress
              color="fuel"
              value={warpAmount}
              className="h-[20px] w-full stripe-bar stripe-bar-fuel/20 stripe-bar-8 stripe-bar-animate-1 "
              classNames={{
                indicator: "duration-1000",
              }}
              max={meta?.capacity ?? 0}
            />
          </div>
          <div className="flex flex-row gap-3 w-full justify-center">
            <ToastValue>
              <CurrencyCounter value={warpAmount} className="" />{" "}
              <span className="opacity-30">/</span> {meta?.capacity}
            </ToastValue>
            <ToastValue>
              <CoinVerticalIcon weight="duotone" className="size-4" />
              <CurrencyCounter value={newCredits} />
              <span className="text-xs font-medium text-warning animate-in fade-in-0 duration-1000">
                -{meta?.cost ?? 0}
              </span>
            </ToastValue>
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  );
};
