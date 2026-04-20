import { useCallback, useEffect, useRef, useState } from "react"

import { CheckIcon } from "@phosphor-icons/react/dist/icons/Check"
import { CopyIcon } from "@phosphor-icons/react/dist/icons/Copy"
import { SpinnerGapIcon } from "@phosphor-icons/react/dist/icons/SpinnerGap"
import { XIcon } from "@phosphor-icons/react/dist/icons/X"
import { useCopyToClipboard } from "@uidotdev/usehooks"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/primitives/ToolTip"
import useGameStore from "@/stores/game"

const DUMP_TIMEOUT_MS = 10000

export function CopyTaskContextButton({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [errored, setErrored] = useState(false)
  const [, copyToClipboard] = useCopyToClipboard()
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return useGameStore.subscribe(
      (s) => s.debugTaskContext,
      (context) => {
        if (!context) return
        clearTimeout(timeoutTimerRef.current)
        setLoading(false)
        setErrored(false)
        copyToClipboard(context)
        setCopied(true)
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
      }
    )
  }, [copyToClipboard])

  useEffect(
    () => () => {
      clearTimeout(copiedTimerRef.current)
      clearTimeout(timeoutTimerRef.current)
    },
    []
  )

  const handleClick = useCallback(() => {
    if (loading) return
    setCopied(false)
    setErrored(false)
    setLoading(true)
    useGameStore.getState().setDebugTaskContext(null)
    useGameStore
      .getState()
      .dispatchAction({ type: "dump-task-context", payload: { task_id: taskId } })
    clearTimeout(timeoutTimerRef.current)
    timeoutTimerRef.current = setTimeout(() => {
      setLoading(false)
      setErrored(true)
    }, DUMP_TIMEOUT_MS)
  }, [loading, taskId])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={
            loading ? "Copying task context"
            : copied ?
              "Task context copied"
            : errored ?
              "Task context copy failed"
            : "Copy task context"
          }
          onClick={handleClick}
          className="z-90 p-0.5 hover:text-white"
        >
          {loading ?
            <SpinnerGapIcon size={14} weight="bold" className="animate-spin" />
          : copied ?
            <CheckIcon size={14} weight="bold" className="text-green-400" />
          : errored ?
            <XIcon
              size={14}
              weight="bold"
              className="text-red-400 animate-[blink_0.2s_step-end_5]"
            />
          : <CopyIcon size={14} weight="bold" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {errored ? "Context copy failed" : "Copy task context"}
      </TooltipContent>
    </Tooltip>
  )
}
