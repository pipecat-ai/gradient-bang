import { useRef, useState } from "react"

import { PaperPlaneRightIcon } from "@phosphor-icons/react"
import { usePipecatClientTransportState } from "@pipecat-ai/client-react"

import { wait } from "@/utils/animation"
import { cn } from "@/utils/tailwind"

import { Button } from "./primitives/Button"
import { Input } from "./primitives/Input"

const THROTTLE_DELAY_MS = 2000

export const TextInputControl = ({
  onSend,
  className,
}: {
  className?: string
  onSend: (text: string) => void
}) => {
  const transportState = usePipecatClientTransportState()

  const inputRef = useRef<HTMLInputElement>(null)
  const [command, setCommand] = useState("")
  const [isDispatching, setIsDispatching] = useState(false)

  const handleSend = async (text: string) => {
    if (isDispatching) return
    setIsDispatching(true)
    onSend(text)
    setCommand("")
    await wait(THROTTLE_DELAY_MS)
    setIsDispatching(false)
    inputRef.current?.focus()
  }

  const isDisabled = transportState !== "ready"
  const isBusy = isDispatching || isDisabled

  return (
    <div className={cn("relative flex-1 flex flex-row items-center min-w-2/3", className)}>
      <Input
        ref={inputRef}
        variant="default"
        placeholder="Enter command"
        value={command}
        disabled={isDisabled}
        readOnly={isDispatching}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && command && !isBusy) {
            handleSend(command)
          }
        }}
        className="flex-1 pr-11"
      />
      <Button
        size="icon"
        variant={isBusy || !command ? "ghost" : "default"}
        disabled={isBusy}
        onClick={() => handleSend(command)}
        className={cn(
          "absolute right-0 border-l-0 outline-none",
          isBusy || !command ? "hover:bg-transparent text-primary/50" : ""
        )}
        loader="stripes"
        isLoading={isDispatching}
      >
        <PaperPlaneRightIcon weight="bold" />
      </Button>
    </div>
  )
}
