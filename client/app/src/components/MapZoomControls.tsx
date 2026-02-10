import { useEffect, useMemo, useState } from "react"

import { useDebouncedCallback } from "use-debounce"
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react"

import {
  DEFAULT_MAX_BOUNDS,
  ZOOM_LEVELS,
  clampZoomIndex,
  getClosestZoomIndex,
} from "@/utils/mapZoom"
import useGameStore from "@/stores/game"

import { Button } from "./primitives/Button"
import { SliderControl } from "./primitives/SliderControl"

export const MapZoomControls = () => {
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const setMapZoomLevel = useGameStore.use.setMapZoomLevel?.()
  const resolvedZoomLevel = mapZoomLevel ?? DEFAULT_MAX_BOUNDS
  const currentIndex = useMemo(
    () => getClosestZoomIndex(resolvedZoomLevel),
    [resolvedZoomLevel]
  )
  const [sliderIndex, setSliderIndex] = useState(currentIndex)

  useEffect(() => {
    setSliderIndex(currentIndex)
  }, [currentIndex])

  useEffect(() => {
    const targetZoom = ZOOM_LEVELS[currentIndex]
    if (mapZoomLevel === undefined || mapZoomLevel !== targetZoom) {
      setMapZoomLevel?.(targetZoom)
    }
  }, [currentIndex, mapZoomLevel, setMapZoomLevel])

  const debouncedTrailing = useDebouncedCallback(
    (value) => {
      const index = clampZoomIndex(value)
      setMapZoomLevel?.(ZOOM_LEVELS[index])
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
          setMapZoomLevel?.(ZOOM_LEVELS[nextIndex])
        }}
        className="shrink-0"
      >
        <MagnifyingGlassPlusIcon weight="bold" />
      </Button>
      <SliderControl
        value={[sliderIndex]}
        min={0}
        max={ZOOM_LEVELS.length - 1}
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
          setMapZoomLevel?.(ZOOM_LEVELS[nextIndex])
        }}
        className="shrink-0"
      >
        <MagnifyingGlassMinusIcon weight="bold" />
      </Button>
    </div>
  )
}
