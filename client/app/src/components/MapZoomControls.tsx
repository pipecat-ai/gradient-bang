import { useEffect, useMemo, useState } from "react"

import { useDebouncedCallback } from "use-debounce"
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react"

import { DEFAULT_MAX_BOUNDS, MAX_BOUNDS, MIN_BOUNDS } from "@/utils/map"
import useGameStore from "@/stores/game"

import { Button } from "./primitives/Button"
import { SliderControl } from "./primitives/SliderControl"

const ZOOM_LEVELS = (() => {
  const levels = Array.from({ length: 5 }, (_, index) =>
    Math.round(MIN_BOUNDS + ((MAX_BOUNDS - MIN_BOUNDS) * index) / 4)
  )
  if (!levels.includes(DEFAULT_MAX_BOUNDS)) {
    levels[1] = DEFAULT_MAX_BOUNDS
  }
  return Array.from(new Set(levels)).sort((a, b) => a - b)
})()

const clampIndex = (index: number) => Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index))

const getClosestZoomIndex = (zoomLevel: number) => {
  let closestIndex = 0
  let closestDistance = Infinity
  ZOOM_LEVELS.forEach((level, index) => {
    const distance = Math.abs(level - zoomLevel)
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  })
  return closestIndex
}

export const MapZoomControls = () => {
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const setMapZoomLevel = useGameStore.use.setMapZoomLevel?.()
  const coursePlot = useGameStore.use.course_plot?.()
  const resolvedZoomLevel = mapZoomLevel ?? DEFAULT_MAX_BOUNDS
  const currentIndex = useMemo(() => getClosestZoomIndex(resolvedZoomLevel), [resolvedZoomLevel])
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
      const index = clampIndex(value)
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
        disabled={coursePlot !== undefined}
        onClick={() => {
          const nextIndex = clampIndex(currentIndex - 1)
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
        disabled={coursePlot !== undefined}
        step={1}
        onValueChange={(value) => {
          const index = clampIndex(value[0])
          setSliderIndex(index)
          debouncedTrailing(index)
        }}
        className="flex-1 shrink-0"
      />
      <Button
        size="icon-sm"
        variant="outline"
        disabled={coursePlot !== undefined}
        onClick={() => {
          const nextIndex = clampIndex(currentIndex + 1)
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
