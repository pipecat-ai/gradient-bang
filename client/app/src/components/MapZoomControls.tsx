import { useEffect, useMemo, useState } from "react"

import { useDebouncedCallback } from "use-debounce"
import {
  ArrowClockwiseIcon,
  EyeClosedIcon,
  EyeIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from "@phosphor-icons/react"
import { WrenchIcon } from "@phosphor-icons/react/dist/ssr"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Popover"
import { ToggleControl } from "@/components/primitives/ToggleControl"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/primitives/ToolTip"
import useGameStore from "@/stores/game"
import { clampZoomIndex, getClosestZoomIndex, zoomLevels } from "@/utils/map"

import { Button } from "./primitives/Button"
import { SliderControl } from "./primitives/SliderControl"

import { DEFAULT_MAX_BOUNDS } from "@/types/constants"

export const MapZoomControls = ({ disabled }: { disabled?: boolean }) => {
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const setMapZoomLevel = useGameStore.use.setMapZoomLevel?.()
  const setMapFitBoundsWorld = useGameStore.use.setMapFitBoundsWorld?.()
  const resetMapView = useGameStore.use.resetMapView?.()
  const coursePlotZoomEnabled = useGameStore((state) => state.coursePlotZoomEnabled)
  const setCoursePlotZoomEnabled = useGameStore.use.setCoursePlotZoomEnabled?.()
  const clearCoursePlot = useGameStore.use.clearCoursePlot?.()
  const mapLegendVisible = useGameStore((state) => state.mapLegendVisible)
  const setMapLegendVisible = useGameStore.use.setMapLegendVisible?.()
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
    },
    500,
    { trailing: true }
  )

  return (
    <>
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
          className="min-h-0 h-full mx-auto"
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
          }}
          className="shrink-0 hover:bg-accent-background border-t"
        >
          <MagnifyingGlassPlusIcon weight="bold" />
        </Button>
      </div>
      <div className="flex flex-col gap-0 w-full bg-background border outline-2 outline-background divide-y divide-y-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="bland"
              size="icon-sm"
              disabled={disabled}
              onClick={() => {
                resetMapView?.()
                clearCoursePlot()
              }}
              className="shrink-0 hover:bg-accent-background"
            >
              <ArrowClockwiseIcon weight="bold" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Reset map</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="bland"
              size="icon-sm"
              disabled={disabled}
              onClick={() => setMapLegendVisible?.(!mapLegendVisible)}
              className="shrink-0 hover:bg-accent-background"
            >
              {mapLegendVisible ?
                <EyeClosedIcon weight="bold" />
              : <EyeIcon weight="bold" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Show legend</TooltipContent>
        </Tooltip>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="bland"
                  size="icon-sm"
                  disabled={disabled}
                  className="shrink-0 hover:bg-accent-background"
                >
                  <WrenchIcon weight="bold" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="left">Settings</TooltipContent>
          </Tooltip>
          <PopoverContent side="left" className="w-64 p-4">
            <div className="flex flex-col gap-2 text-xs uppercase">
              <dl className="flex flex-row items-center justify-between">
                <dt className="font-medium">Course plot zoom</dt>
                <dd className="text-muted-foreground">
                  <ToggleControl
                    size="sm"
                    checked={coursePlotZoomEnabled}
                    onCheckedChange={(checked) => setCoursePlotZoomEnabled?.(checked)}
                  />
                </dd>
              </dl>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </>
  )
}
