import { useEffect } from "react"

import { CheckCircleIcon } from "@phosphor-icons/react"

import useAudioStore from "@/stores/audio"

import { Card, CardContent } from "../primitives/Card"
import { ToastBase, ToastTitle } from "./ToastBase"

import type { Toast } from "@/types/toasts"

interface QuestStepCompletedToastProps {
  toast: Toast & { type: "quest.step_completed" }
  onAnimateIn?: () => void
  onAnimationComplete?: () => void
  onDismiss?: () => void
}

export const QuestStepCompletedToast = ({
  toast,
  onAnimateIn,
  onAnimationComplete,
  onDismiss,
}: QuestStepCompletedToastProps) => {
  const { meta } = toast

  useEffect(() => {
    useAudioStore.getState().playSound("chime8")
  }, [])

  if (!meta) return null

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
        <CardContent className="flex flex-col h-full justify-between items-center gap-ui-xs">
          <ToastTitle className="text-terminal">Step Complete</ToastTitle>
          <figure className="size-12 flex items-center justify-center bg-accent-background elbow elbow-1 elbow-offset-0 elbow-size-8 elbow-subtle">
            <CheckCircleIcon weight="duotone" size={20} className="size-6 text-terminal" />
          </figure>
          <div className="flex flex-col gap-0.5 w-full items-center text-center">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {meta.quest_name}
            </span>
            <span className="text-sm font-bold uppercase text-foreground">{meta.step_name}</span>
            {meta.reward_credits ?
              <span className="text-xs text-terminal mt-0.5">
                +{meta.reward_credits.toLocaleString()} credits available
              </span>
            : null}
          </div>
        </CardContent>
      </Card>
    </ToastBase>
  )
}
