import { useEffect } from "react"

import useAudioStore from "@/stores/audio"
import { getShipLogoImage } from "@/utils/images"

import { Card, CardContent } from "../primitives/Card"
import { ToastBase, ToastTitle } from "./ToastBase"

import type { Toast } from "@/types/toasts"

interface ShipDestroyedToastProps {
  toast: Toast & { type: "ship.destroyed" }
  onAnimateIn?: () => void
  onAnimationComplete?: () => void
  onDismiss?: () => void
}
export const ShipDestroyedToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: ShipDestroyedToastProps) => {
  const playSound = useAudioStore.use.playSound()

  const { meta } = toast

  useEffect(() => {
    playSound("chime8")
  }, [playSound])

  const shipLogo = getShipLogoImage(meta?.ship_type ?? "")

  return (
    <ToastBase
      onAnimateIn={onAnimateIn}
      onAnimationComplete={onAnimationComplete}
      onClick={onDismiss}
    >
      <Card
        variant="stripes"
        size="sm"
        className="stripe-frame-destructive/30 stripe-frame-2 stripe-frame-size-2 border-none bg-transparent w-full h-full"
      >
        <CardContent className="flex flex-col h-full justify-between items-center">
          <ToastTitle className="text-destructive">Ship Destroyed</ToastTitle>
          {shipLogo && (
            <img
              src={shipLogo}
              alt={meta?.ship_name}
              className="size-12 opacity-50 grayscale"
            />
          )}
          <div className="flex flex-col gap-1 w-full items-center uppercase text-sm">
            <span className="text-destructive font-semibold">{meta?.ship_name}</span>
            {meta?.sector !== undefined && (
              <span className="text-xxs text-muted-foreground">Sector {meta.sector}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  )
}
