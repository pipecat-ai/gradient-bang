import { useState } from "react"

import { useDebouncedCallback } from "use-debounce"
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react"

import { DEFAULT_MAX_BOUNDS } from "@/components/screens/MapScreen"
import useGameStore from "@/stores/game"

import { Button } from "./primitives/Button"
import { SliderControl } from "./primitives/SliderControl"

export const MapZoomControls = () => {
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel) ?? DEFAULT_MAX_BOUNDS
  const setMapZoomLevel = useGameStore.use.setMapZoomLevel?.()
  const [sliderValue, setSliderValue] = useState(mapZoomLevel)

  const debounced = useDebouncedCallback(
    (value) => {
      setMapZoomLevel(value)
    },
    200,
    { leading: true }
  )

  const debouncedTrailing = useDebouncedCallback(
    (value) => {
      setMapZoomLevel(value)
    },
    500,
    { trailing: true }
  )

  return (
    <div className="flex flex-row gap-ui-xs w-full">
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => {
          debounced(mapZoomLevel - 5)
        }}
        className="shrink-0"
      >
        <MagnifyingGlassPlusIcon weight="bold" />
      </Button>
      <SliderControl
        value={[sliderValue]}
        min={1}
        max={50}
        step={1}
        onValueChange={(value) => {
          setSliderValue(value[0])
          debouncedTrailing(value[0])
        }}
        className="flex-1 shrink-0"
      />
      <Button
        size="icon-sm"
        variant="outline"
        onClick={() => {
          debounced(mapZoomLevel + 5)
        }}
        className="shrink-0"
      >
        <MagnifyingGlassMinusIcon weight="bold" />
      </Button>
    </div>
  )
}
