import { useEffect } from "react"

import useAudioStore from "@/stores/audio"
import { getShipLogoImage } from "@/utils/images"

import { Card, CardContent } from "../primitives/Card"
import { ToastBase, ToastTitle } from "./ToastBase"

import type { Toast } from "@/types/toasts"

interface ShipPurchasedToastProps {
  toast: Toast & { type: "ship.purchased" }
  onAnimateIn?: () => void
  onAnimationComplete?: () => void
  onDismiss?: () => void
}
export const ShipPurchasedToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: ShipPurchasedToastProps) => {
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
          <ToastTitle className="text-terminal">Ship Purchased</ToastTitle>
          <img
            src={shipLogo}
            alt={meta?.ship?.ship_name}
            className="size-12 animate-in zoom-in-50 fade-in-0 duration-1000 origin-center"
          />
          <div className="flex flex-row gap-3 w-full justify-center items-center uppercase text-sm">
            {meta?.ship?.ship_name}
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  )
}
