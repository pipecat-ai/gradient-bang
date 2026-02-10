import { UsersIcon } from "@phosphor-icons/react"

import { Card, CardContent } from "../primitives/Card"
import { ToastBase, ToastTitle } from "./ToastBase"

import type { Toast } from "@/types/toasts"

interface CorporationCreatedToastProps {
  toast: Toast & { type: "corporation.created" }
  onAnimateIn?: () => void
  onAnimationComplete?: () => void
  onDismiss?: () => void
}
export const CorporationCreatedToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: CorporationCreatedToastProps) => {
  const { meta } = toast

  const corporationName = meta?.corporation?.name ?? "Unknown"
  if (!corporationName) {
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
          <ToastTitle className="text-terminal">Corporation Created</ToastTitle>
          <figure className="size-12 flex items-center justify-center bg-accent-background elbow elbow-1 elbow-offset-0 elbow-size-8 elbow-subtle">
            <UsersIcon weight="duotone" size={20} className="size-6 text-foreground" />
          </figure>
          <div className="flex flex-row gap-3 w-full justify-center items-center uppercase text-sm">
            {meta?.corporation?.name}
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  )
}
