import { useEffect } from "react"

import { UserMinusIcon } from "@phosphor-icons/react"

import useAudioStore from "@/stores/audio"

import { Card, CardContent } from "../primitives/Card"
import { ToastBase, ToastTitle } from "./ToastBase"

import type { Toast } from "@/types/toasts"

interface CorporationLeftToastProps {
  toast: Toast & { type: "corporation.left" }
  onAnimateIn?: () => void
  onAnimationComplete?: () => void
  onDismiss?: () => void
}

export const CorporationLeftToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: CorporationLeftToastProps) => {
  const { meta } = toast

  useEffect(() => {
    useAudioStore.getState().playSound("chime10")
  }, [])

  if (!meta) {
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
          <ToastTitle className="text-terminal">Corporation Left</ToastTitle>
          <figure className="size-12 flex items-center justify-center bg-accent-background elbow elbow-1 elbow-offset-0 elbow-size-8 elbow-subtle">
            <UserMinusIcon weight="duotone" size={20} className="size-6 text-foreground" />
          </figure>
          <div className="flex flex-row gap-3 w-full justify-center items-center uppercase text-sm">
            {meta.corp_name}
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  )
}
