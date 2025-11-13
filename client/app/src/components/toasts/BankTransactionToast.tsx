import type { Toast } from "@/types/toasts";
import { wait } from "@/utils/animation";
import { cn } from "@/utils/tailwind";
import {
  ArrowsLeftRightIcon,
  HandCoinsIcon,
  VaultIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { CurrencyCounter } from "../CurrencyCounter";
import { Card, CardContent } from "../primitives/Card";
import { ToastBase, ToastTitle, ToastValue } from "./ToastBase";

interface BankTransactionToastProps {
  toast: Toast & { type: "bank.transaction" };
  onAnimateIn?: () => void;
  onAnimationComplete?: () => void;
  onDismiss?: () => void;
}
export const BankTransactionToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: BankTransactionToastProps) => {
  const { meta } = toast;
  const [creditsOnHandBalance, setCreditsOnHandBalance] = useState(
    meta?.credits_on_hand_before ?? 0
  );
  const [creditsInBankBalance, setCreditsInBankBalance] = useState(
    meta?.credits_in_bank_before ?? 0
  );
  useEffect(() => {
    wait(500).then(() => {
      setCreditsOnHandBalance(meta?.credits_on_hand_after ?? 0);
      setCreditsInBankBalance(meta?.credits_in_bank_after ?? 0);
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
        <CardContent className="flex flex-col h-full justify-between items-center">
          <ToastTitle>
            Credits {meta?.direction === "deposit" ? "Deposited" : "Withdrawn"}
          </ToastTitle>

          <div className="flex flex-row gap-3 w-full justify-center items-center">
            <ToastValue
              className={`py-2 flex-1 ${
                meta?.direction === "deposit" &&
                "numerical-badge-flashing-increment"
              }`}
            >
              <VaultIcon weight="duotone" className="size-6" />
              <CurrencyCounter
                value={creditsInBankBalance}
                className="text-lg"
              />
              <span
                className={cn(
                  "text-xs font-medium animate-in fade-in-0 duration-1000",
                  meta?.direction === "deposit"
                    ? "text-success"
                    : "text-warning"
                )}
              >
                {meta?.direction === "deposit" ? "+" : "-"}
                {meta?.amount ?? 0}
              </span>
            </ToastValue>
            <ArrowsLeftRightIcon size={24} className="text-border" />
            <ToastValue
              className={`py-2 flex-1 ${
                meta?.direction === "withdraw" &&
                "numerical-badge-flashing-increment"
              }`}
            >
              <HandCoinsIcon weight="duotone" className="size-6" />
              <CurrencyCounter
                value={creditsOnHandBalance}
                className="text-lg"
              />
              <span
                className={cn(
                  "text-xs font-medium animate-in fade-in-0 duration-1000",
                  meta?.direction === "deposit"
                    ? "text-warning"
                    : "text-success"
                )}
              >
                {meta?.direction === "deposit" ? "-" : "+"}
                {meta?.amount ?? 0}
              </span>
            </ToastValue>
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  );
};
