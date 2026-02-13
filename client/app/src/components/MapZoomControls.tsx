import { useEffect, useMemo, useState } from "react"

import { useDebouncedCallback } from "use-debounce"
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { clampZoomIndex, getClosestZoomIndex, zoomLevels } from "@/utils/map"

import { Button } from "./primitives/Button"
import { SliderControl } from "./primitives/SliderControl"

import { DEFAULT_MAX_BOUNDS } from "@/types/constants"

export const MapZoomControls = ({ disabled }: { disabled?: boolean }) => {
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const setMapZoomLevel = useGameStore.use.setMapZoomLevel?.()
  const setMapFitBoundsWorld = useGameStore.use.setMapFitBoundsWorld?.()
  const requestMapAutoRecenter = useGameStore.use.requestMapAutoRecenter?.()
  const resolvedZoomLevel = mapZoomLevel ?? DEFAULT_MAX_BOUNDS
  const currentIndex = useMemo(() => getClosestZoomIndex(resolvedZoomLevel), [resolvedZoomLevel])
  const [sliderIndex, setSliderIndex] = useState(currentIndex)

  useEffect(() => {
    setSliderIndex(currentIndex)
  }, [currentIndex])

  useEffect(() => {
    if (mapZoomLevel === undefined) {
      // Initialize once without snapping programmatic zooms to discrete levels.
      setMapZoomLevel?.(zoomLevels[currentIndex])
    }
  }, [currentIndex, mapZoomLevel, setMapZoomLevel])

  const debouncedTrailing = useDebouncedCallback(
    (value) => {
      const index = clampZoomIndex(value)
      setMapFitBoundsWorld?.(undefined)
      setMapZoomLevel?.(zoomLevels[index])
      requestMapAutoRecenter?.("ui-zoom")
    },
    500,
    { trailing: true }
  )

  return (
    <div className="flex flex-col gap-ui-xxs w-full bg-background border outline-2 outline-background h-62 @6xl/main:h-80">
      <Button
        size="icon-sm"
        variant="bland"
        disabled={disabled}
        onClick={() => {
          const nextIndex = clampZoomIndex(currentIndex + 1)
          setSliderIndex(nextIndex)
          setMapFitBoundsWorld?.(undefined)
          setMapZoomLevel?.(zoomLevels[nextIndex])
          requestMapAutoRecenter?.("ui-zoom")
        }}
        className="shrink-0 hover:bg-accent-background border-b"
      >
        <MagnifyingGlassMinusIcon weight="bold" />
      </Button>
      <SliderControl
        orientation="vertical"
        disabled={disabled}
        value={[sliderIndex]}
        min={0}
        max={zoomLevels.length - 1}
        step={1}
        onValueChange={(value) => {
          const index = clampZoomIndex(value[0])
          setSliderIndex(index)
          debouncedTrailing(index)
        }}
        className="flex-1 min-h-0 h-full"
      />
      <Button
        variant="bland"
        size="icon-sm"
        disabled={disabled}
        onClick={() => {
          const nextIndex = clampZoomIndex(currentIndex - 1)
          setSliderIndex(nextIndex)
          setMapFitBoundsWorld?.(undefined)
          setMapZoomLevel?.(zoomLevels[nextIndex])
          requestMapAutoRecenter?.("ui-zoom")
        }}
        className="shrink-0 hover:bg-accent-background border-t"
      >
        <MagnifyingGlassPlusIcon weight="bold" />
      </Button>
    </div>
  )
}
