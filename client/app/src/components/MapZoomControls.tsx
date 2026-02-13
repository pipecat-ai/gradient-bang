import { useEffect, useMemo, useState } from "react"

import { useDebouncedCallback } from "use-debounce"
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { clampZoomIndex, getClosestZoomIndex, zoomLevels } from "@/utils/map"

import { Button } from "./primitives/Button"
import { SliderControl } from "./primitives/SliderControl"

import { DEFAULT_MAX_BOUNDS } from "@/types/constants"

export const MapZoomControls = () => {
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
    <div className="flex flex-row gap-ui-xs w-full">
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => {
          const nextIndex = clampZoomIndex(currentIndex - 1)
          setSliderIndex(nextIndex)
          setMapFitBoundsWorld?.(undefined)
          setMapZoomLevel?.(zoomLevels[nextIndex])
          requestMapAutoRecenter?.("ui-zoom")
        }}
        className="shrink-0"
      >
        <MagnifyingGlassPlusIcon weight="bold" />
      </Button>
      <SliderControl
        value={[sliderIndex]}
        min={0}
        max={zoomLevels.length - 1}
        step={1}
        onValueChange={(value) => {
          const index = clampZoomIndex(value[0])
          setSliderIndex(index)
          debouncedTrailing(index)
        }}
        className="flex-1 shrink-0"
      />
      <Button
        size="icon-sm"
        variant="outline"
        onClick={() => {
          const nextIndex = clampZoomIndex(currentIndex + 1)
          setSliderIndex(nextIndex)
          setMapFitBoundsWorld?.(undefined)
          setMapZoomLevel?.(zoomLevels[nextIndex])
          requestMapAutoRecenter?.("ui-zoom")
        }}
        className="shrink-0"
      >
        <MagnifyingGlassMinusIcon weight="bold" />
      </Button>
    </div>
  )
}
