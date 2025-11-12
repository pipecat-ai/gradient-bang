import useGameStore from "@/stores/game";
import type { Toast } from "@/types/toasts";
import { cn } from "@/utils/tailwind";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { BankTransactionToast } from "./BankTransactionToast";
import { FuelPurchasedToast } from "./FuelPurchasedToast";
import { SalvageCollectedToast } from "./SalvageCollectedToast";
import { SalvageCreatedToast } from "./SalvageCreatedToast";
import { TradeExecutedToast } from "./TradeExecutedToast";
import { TransferToast } from "./TransferToast";

const TOAST_DURATION_MS = 4000;

export const ToastContainer = () => {
  const toasts = useGameStore.use.toasts();
  const removeToast = useGameStore.use.removeToast();
  const [isExiting, setIsExiting] = useState(false);

  const currentToast = toasts[0];

  useEffect(() => {
    if (!currentToast || isExiting) return;

    // Set timer to trigger exit animation
    const timer = setTimeout(() => {
      setIsExiting(true);
    }, TOAST_DURATION_MS);

    return () => clearTimeout(timer);
  }, [currentToast, isExiting]);

  const handleAnimationComplete = () => {
    if (currentToast) {
      removeToast(currentToast.id);
      setIsExiting(false);
    }
  };

  const handleDismiss = () => {
    if (!isExiting) {
      setIsExiting(true);
    }
  };

  const renderToast = (toast: Toast) => {
    const baseProps = {
      onDismiss: handleDismiss,
    };

    switch (toast.type) {
      case "warp.purchase":
        return <FuelPurchasedToast toast={toast} {...baseProps} />;
      case "bank.transaction":
        return <BankTransactionToast toast={toast} {...baseProps} />;
      case "transfer":
        return <TransferToast toast={toast} {...baseProps} />;
      case "trade.executed":
        return <TradeExecutedToast toast={toast} {...baseProps} />;
      case "salvage.collected":
        return <SalvageCollectedToast toast={toast} {...baseProps} />;
      case "salvage.created":
        return <SalvageCreatedToast toast={toast} {...baseProps} />;
      default:
        return null;
    }
  };

  const dotCount = Math.min(toasts.length, 10);
  const toastActive = toasts.length > 0 && !isExiting;

  const containerClasses = cn(
    "relative h-toast w-full items-center justify-center bracket bracket-2 transition-all duration-300",
    {
      "opacity-10 bg-background/70 bracket-white": !toastActive,
      "opacity-100 bg-background/80 bracket-white motion-safe:bg-background/70 motion-safe:backdrop-blur-sm":
        toastActive,
    }
  );

  return (
    <div className="relative -mt-10 pointer-events-none w-toast z-(--z-toasts) mb-auto flex flex-col gap-2">
      <div
        className={containerClasses}
        style={{ transformOrigin: "top center" }}
      >
        <AnimatePresence mode="wait" onExitComplete={handleAnimationComplete}>
          {currentToast && !isExiting && (
            <div key={currentToast.id} className="w-full h-full p-ui-xs">
              {renderToast(currentToast)}
            </div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {toasts.length > 1 && (
          <motion.div
            key="toast-indicators"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="flex gap-1.5 pointer-events-none mx-auto grow-0 items-center justify-center bg-background/30 px-2 py-2"
          >
            {Array.from({ length: dotCount }).map((_, index) => (
              <div
                key={index}
                className={`w-2 h-2 transition-all duration-30 ${
                  index === 0
                    ? "bg-foreground animate-pulse"
                    : "bg-muted-foreground/30 border border-muted-foreground/50"
                }`}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
