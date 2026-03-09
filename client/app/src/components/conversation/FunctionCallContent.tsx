import { useState } from "react"

import {
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  WrenchIcon,
  XIcon,
} from "@phosphor-icons/react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/primitives/Collapsible"
import { cn } from "@/utils/tailwind"

import { MessageTimestamp } from "./MessageTimestamp"

import type { FunctionCallData, FunctionCallRenderer } from "@/types/conversation"

interface FunctionCallContentProps {
  functionCall: FunctionCallData
  /** Timestamp for the function call message */
  createdAt?: string | number
  /** Label for function call entries */
  functionCallLabel?: string
  /** Custom renderer for function call messages. When provided, replaces the default rendering. */
  functionCallRenderer?: FunctionCallRenderer
  classNames?: {
    container?: string
  }
}

const StatusIcon: React.FC<{
  status: FunctionCallData["status"]
  cancelled?: boolean
}> = ({ status, cancelled }) => {
  if (status === "completed" && cancelled) {
    return <XIcon size={14} className="text-destructive" />
  }
  switch (status) {
    case "started":
    case "in_progress":
      return <CircleNotchIcon size={12} className="animate-spin" weight="bold" />
    case "completed":
      return <CheckIcon size={12} className="text-success" weight="bold" />
  }
}

export const FunctionCallContent: React.FC<FunctionCallContentProps> = ({
  functionCall,
  createdAt,
  functionCallLabel = "Function call",
  functionCallRenderer,
  classNames = {},
}) => {
  const [isOpen, setIsOpen] = useState(false)

  if (functionCallRenderer) {
    return <>{functionCallRenderer(functionCall)}</>
  }

  const hasDetails =
    (functionCall.args && Object.keys(functionCall.args).length > 0) ||
    functionCall.result !== undefined

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={cn("flex flex-col gap-1", classNames.container)}>
        <CollapsibleTrigger asChild disabled={!hasDetails}>
          <button
            className={cn(
              "w-fit text-subtle-foreground font-extrabold text-xxs uppercase inline-flex gap-1 items-center",
              "transition-colors select-none",
              hasDetails && "hover:text-foreground cursor-pointer",
              !hasDetails && "cursor-default"
            )}
          >
            {createdAt && (
              <MessageTimestamp createdAt={createdAt} className="text-accent-foreground" />
            )}
            <StatusIcon status={functionCall.status} cancelled={functionCall.cancelled} />
            <WrenchIcon weight="fill" size={11} className="size-2.75" />
            <span>{functionCallLabel}</span>
            {functionCall.function_name && (
              <span className="font-bold text-medium">({functionCall.function_name})</span>
            )}
            {hasDetails && (
              <CaretRightIcon
                size={11}
                weight="bold"
                className={cn("transition-transform duration-200", isOpen && "rotate-90")}
              />
            )}
          </button>
        </CollapsibleTrigger>

        {hasDetails && (
          <CollapsibleContent>
            <div
              className={cn(
                "pl-3 ml-0! border-l-2 border-accent text-xxs",
                "flex flex-col gap-2 mt-1",
                hasDetails && "ml-3.5"
              )}
            >
              {functionCall.args && Object.keys(functionCall.args).length > 0 && (
                <div>
                  <div className="font-semibold text-accent-foreground mb-1 uppercase">
                    Arguments
                  </div>
                  <pre className="bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(functionCall.args, null, 2)}
                  </pre>
                </div>
              )}

              {functionCall.result !== undefined && (
                <div>
                  <div className="font-semibold text-accent-foreground mb-1 uppercase">Result</div>
                  <pre className="bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {typeof functionCall.result === "string" ?
                      functionCall.result
                    : JSON.stringify(functionCall.result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  )
}
