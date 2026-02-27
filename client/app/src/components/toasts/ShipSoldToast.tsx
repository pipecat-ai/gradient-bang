import { useEffect } from "react"

import useAudioStore from "@/stores/audio"
import { getShipLogoImage } from "@/utils/images"

import { Card, CardContent } from "../primitives/Card"
import { ToastBase, ToastTitle } from "./ToastBase"

import type { Toast } from "@/types/toasts"

interface ShipSoldToastProps {
  toast: Toast & { type: "ship.sold" }
  onAnimateIn?: () => void
  onAnimationComplete?: () => void
  onDismiss?: () => void
}
export const ShipSoldToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: ShipSoldToastProps) => {
  const playSound = useAudioStore.use.playSound()

  const { meta } = toast

  useEffect(() => {
    playSound("chime8")
  }, [playSound])

  const shipLogo = getShipLogoImage(meta?.ship?.ship_type ?? "")
  if (!shipLogo) {
    return null
  }
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
          <ToastTitle className="text-terminal">Ship Sold</ToastTitle>
          <img
            src={shipLogo}
            alt={meta?.ship?.ship_name}
            className="size-12 animate-in zoom-in-50 fade-in-0 duration-1000 origin-center opacity-50"
          />
          <div className="flex flex-col gap-1 w-full items-center uppercase text-sm">
            <span>{meta?.ship?.ship_name}</span>
            {meta?.trade_in_value != null && (
              <span className="text-xs text-terminal/70">
                +{meta.trade_in_value.toLocaleString()} credits
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  )
}
