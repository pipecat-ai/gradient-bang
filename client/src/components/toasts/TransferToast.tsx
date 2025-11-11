import type { Toast } from "@/types/toasts";
import { cn } from "@/utils/tailwind";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CoinVerticalIcon,
  GasCanIcon,
} from "@phosphor-icons/react";
import { Card, CardContent } from "../primitives/Card";
import { ToastBase, ToastTitle, ToastValue } from "./ToastBase";

interface TransferToastProps {
  toast: Toast & { type: "transfer" };
  onAnimateIn?: () => void;
  onAnimationComplete?: () => void;
  onDismiss?: () => void;
}
export const TransferToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: TransferToastProps) => {
  const { meta } = toast;
  const transfer_commodity = meta?.transfer_details?.credits
    ? "Credits"
    : "Warp Fuel Power";

  return (
    <ToastBase
      onAnimateIn={onAnimateIn}
      onAnimationComplete={onAnimationComplete}
      onClick={onDismiss}
    >
      <Card
        variant="stripes"
        size="sm"
        className={`stripe-frame-2 stripe-frame-size-2 border-none bg-transparent w-full h-full ${
          meta?.direction === "received"
            ? "stripe-frame-success/30"
            : "stripe-frame-warning/30"
        }`}
      >
        <CardContent className="flex flex-col h-full justify-between items-center">
          <ToastTitle>
            {meta?.direction === "received" ? (
              <span className="text-success">Received</span>
            ) : (
              <span className="text-warning">Sent</span>
            )}{" "}
            {transfer_commodity}
          </ToastTitle>

          <div className="flex flex-row gap-3 w-full justify-center items-center">
            <div
              className={cn(
                "flex flex-col gap-3 w-full justify-center items-center bg-black h-full uppercase text-xs font-bold tracking-widest",
                meta?.direction === "received" ? "order-0" : "order-2"
              )}
            >
              {meta?.direction === "received" ? meta?.from.name : meta?.to.name}
            </div>
            {meta?.direction === "received" ? (
              <ArrowLeftIcon
                size={24}
                className="shrink-0 text-white order-1"
              />
            ) : (
              <ArrowRightIcon
                size={24}
                className="shrink-0 text-white order-1"
              />
            )}
            <div
              className={cn(
                "flex flex-row gap-3 w-full justify-center items-center",
                meta?.direction === "received" ? "order-2" : "order-0"
              )}
            >
              <ToastValue className="py-2 flex-1 animate-pulse">
                {transfer_commodity === "Credits" ? (
                  <CoinVerticalIcon weight="duotone" className="size-6" />
                ) : (
                  <GasCanIcon weight="duotone" className="size-6" />
                )}
                <span>
                  {meta?.transfer_details?.credits ??
                    meta?.transfer_details?.warp_power ??
                    0}
                </span>
              </ToastValue>
            </div>
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  );
};
