import { useCallback, useState } from "react"

import { Button } from "@/components/primitives/Button"
import { CardContent } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import { Input } from "@/components/primitives/Input"
import { Label } from "@/components/primitives/Label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/primitives/Select"
import { SliderControl } from "@/components/primitives/SliderControl"
import { useGameContext } from "@/hooks/useGameContext"

export const GarrisonUpdateForm = ({ garrison }: { garrison: Garrison }) => {
  const [mode, setMode] = useState<Garrison["mode"]>(garrison.mode)
  const [tollAmount, setTollAmount] = useState(garrison.toll_amount)
  const { sendUserTextInput } = useGameContext()

  const handleModeChange = useCallback((value: string) => {
    const newMode = value as Garrison["mode"]
    setMode(newMode)
  }, [])

  const handleTollAmountChange = useCallback((value: number) => {
    setTollAmount(value)
  }, [])

  const handleSubmit = useCallback(() => {
    const parts = [`Update garrison: mode=${mode}`]
    if (mode === "toll") {
      parts.push(`tollAmount=${tollAmount}`)
    }
    sendUserTextInput(parts.join(", "))
  }, [mode, tollAmount, sendUserTextInput])

  return (
    <CardContent className="flex flex-col gap-ui-sm">
      <Divider variant="dotted" className="h-1.5 text-accent-background" />

      <Label className="text-xs uppercase font-bold">Set mode:</Label>
      <Select value={mode} onValueChange={handleModeChange}>
        <SelectTrigger className="flex-1 w-full">
          <SelectValue placeholder="Select mode" className="truncate">
            <span className="truncate">{mode}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="offensive">Offensive</SelectItem>
          <SelectItem value="defensive">Defensive</SelectItem>
          <SelectItem value="toll">Toll</SelectItem>
        </SelectContent>
      </Select>

      {mode === "toll" && (
        <>
          <Label className="text-xs uppercase font-bold">Toll amount:</Label>
          <div className="flex flex-row items-center gap-2">
            <SliderControl
              min={0}
              max={10000}
              step={100}
              value={[tollAmount]}
              onValueChange={([v]) => handleTollAmountChange(v)}
              className="flex-1 shrink-0"
            />
            <Input
              type="number"
              size="sm"
              min={0}
              max={10000}
              step={100}
              value={tollAmount}
              onChange={(e) => handleTollAmountChange(Number(e.target.value))}
              className="w-20 text-center appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
            />
          </div>
        </>
      )}

      <Button size="sm" onClick={handleSubmit}>
        Update garrison
      </Button>
    </CardContent>
  )
}
