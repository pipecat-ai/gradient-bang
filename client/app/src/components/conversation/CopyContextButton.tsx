import { useCallback, useEffect, useRef, useState } from "react"

import { CheckIcon } from "@phosphor-icons/react/dist/icons/Check"
import { CopyIcon } from "@phosphor-icons/react/dist/icons/Copy"
import { SpinnerGapIcon } from "@phosphor-icons/react/dist/icons/SpinnerGap"
import { useCopyToClipboard } from "@uidotdev/usehooks"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/primitives/ToolTip"
import useGameStore from "@/stores/game"

export function CopyContextButton() {
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [, copyToClipboard] = useCopyToClipboard()
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    // Zustand subscription runs outside React's render cycle — setState calls
    // here are external-system callbacks, not synchronous effect body calls
    return useGameStore.subscribe(
      (s) => s.debugLLMContext,
      (context) => {
        if (!context) return
        setLoading(false)
        copyToClipboard(context)
        setCopied(true)
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
      }
    )
  }, [copyToClipboard])

  useEffect(() => () => clearTimeout(copiedTimerRef.current), [])

  const handleClick = useCallback(() => {
    if (loading) return
    setCopied(false)
    setLoading(true)
    useGameStore.getState().setDebugLLMContext(null)
    useGameStore.getState().dispatchAction({ type: "dump-llm-context" })
  }, [loading])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={
            loading ? "Copying conversation context"
            : copied ?
              "Conversation context copied"
            : "Copy conversation context"
          }
          onClick={handleClick}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-white"
        >
          {loading ?
            <SpinnerGapIcon size={14} weight="bold" className="animate-spin" />
          : copied ?
            <CheckIcon size={14} weight="bold" className="text-green-400" />
          : <CopyIcon size={14} weight="bold" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">Copy context</TooltipContent>
    </Tooltip>
  )
}
