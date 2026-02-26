import { useEffect, useState } from "react"

import { AnimatePresence, motion } from "motion/react"

import { BankTransactionToast } from "@/components/toasts/BankTransactionToast"
import { FuelPurchasedToast } from "@/components/toasts/FuelPurchasedToast"
import { SalvageCollectedToast } from "@/components/toasts/SalvageCollectedToast"
import { SalvageCreatedToast } from "@/components/toasts/SalvageCreatedToast"
import { ShipDestroyedToast } from "@/components/toasts/ShipDestroyedToast"
import { ShipPurchasedToast } from "@/components/toasts/ShipPurchasedToast"
import { ShipSoldToast } from "@/components/toasts/ShipSoldToast"
import { TradeExecutedToast } from "@/components/toasts/TradeExecutedToast"
import { TransferToast } from "@/components/toasts/TransferToast"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { CorporationCreatedToast } from "./CorporationCreated"

import type { Toast } from "@/types/toasts"

const TOAST_DURATION_MS = 3500

export const ToastContainer = () => {
  const toasts = useGameStore.use.toasts()
  const getNextToast = useGameStore.use.getNextToast()
  const lockToast = useGameStore.use.lockToast()
  const displayingToastId = useGameStore.use.displayingToastId()
  const removeToast = useGameStore.use.removeToast()
  const [isExiting, setIsExiting] = useState(false)

  const currentToast = getNextToast()

  // Lock the toast when it becomes current
  useEffect(() => {
    if (currentToast && displayingToastId !== currentToast.id) {
      lockToast(currentToast.id)
    }
  }, [currentToast, displayingToastId, lockToast])

  useEffect(() => {
    if (!currentToast || isExiting) return

    const timer = setTimeout(() => {
      setIsExiting(true)
    }, TOAST_DURATION_MS)

    return () => clearTimeout(timer)
  }, [currentToast, isExiting])

  const handleAnimationComplete = () => {
    if (currentToast) {
      removeToast(currentToast.id)
      setIsExiting(false)
    }
  }

  const handleDismiss = () => {
    if (!isExiting) {
      setIsExiting(true)
    }
  }

  const renderToast = (toast: Toast) => {
    const baseProps = {
      onDismiss: handleDismiss,
    }

    switch (toast.type) {
      case "corporation.created":
        return <CorporationCreatedToast toast={toast} {...baseProps} />
      case "ship.purchased":
        return <ShipPurchasedToast toast={toast} {...baseProps} />
      case "ship.sold":
        return <ShipSoldToast toast={toast} {...baseProps} />
      case "ship.destroyed":
        return <ShipDestroyedToast toast={toast} {...baseProps} />
      case "warp.purchase":
        return <FuelPurchasedToast toast={toast} {...baseProps} />
      case "bank.transaction":
        return <BankTransactionToast toast={toast} {...baseProps} />
      case "transfer":
        return <TransferToast toast={toast} {...baseProps} />
      case "trade.executed":
        return <TradeExecutedToast toast={toast} {...baseProps} />
      case "salvage.collected":
        return <SalvageCollectedToast toast={toast} {...baseProps} />
      case "salvage.created":
        return <SalvageCreatedToast toast={toast} {...baseProps} />
      default:
        return null
    }
  }

  const dotCount = Math.min(toasts.length, 10)
  const toastActive = toasts.length > 0 && !isExiting

  const containerClasses = cn(
    "relative h-toast w-full items-center justify-center transition-all duration-300",
    {
      "bg-transparent": !toastActive,
      "opacity-100 bracket bracket-2 bg-background/80 bracket-white motion-safe:bg-background/60 motion-safe:backdrop-blur-sm":
        toastActive,
    }
  )

  return (
    <div className="absolute top-ui-sm left-1/2 -translate-x-1/2 pointer-events-none w-toast z-(--z-toasts) mb-auto flex flex-col">
      <div className={containerClasses} style={{ transformOrigin: "top center" }}>
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
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="flex gap-1.5 pointer-events-none mx-auto grow-0 items-center justify-center bg-background/30 px-2 py-2"
          >
            {Array.from({ length: dotCount }).map((_, index) => (
              <div
                key={index}
                className={`w-2 h-2 transition-all duration-30 ${
                  index === 0 ?
                    "bg-foreground animate-pulse"
                  : "bg-muted-foreground/30 border border-muted-foreground/50"
                }`}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
