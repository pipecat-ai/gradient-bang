import {
  ArrowClockwiseIcon,
  EyeClosedIcon,
  EyeIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from "@phosphor-icons/react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/primitives/ToolTip"
import useGameStore from "@/stores/game"
import {
  clampZoomIndex,
  getClosestZoomIndex,
  sliderValueToZoomLevel,
  zoomLevels,
  zoomLevelToSliderValue,
} from "@/utils/map"

import { Button } from "./primitives/Button"
import { SliderControl } from "./primitives/SliderControl"

import { DEFAULT_MAX_BOUNDS } from "@/types/constants"

export const MapZoomControls = ({ disabled }: { disabled?: boolean }) => {
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const setMapZoomLevelFromControl = useGameStore.use.setMapZoomLevelFromControl?.()
  const recenterMap = useGameStore.use.recenterMap?.()
  const clearCoursePlot = useGameStore.use.clearCoursePlot?.()
  const mapLegendVisible = useGameStore((state) => state.mapLegendVisible)
  const setMapLegendVisible = useGameStore.use.setMapLegendVisible?.()
  const resolvedZoomLevel = mapZoomLevel ?? DEFAULT_MAX_BOUNDS
  const currentIndex = getClosestZoomIndex(resolvedZoomLevel)
  const sliderValue = zoomLevelToSliderValue(resolvedZoomLevel)
  const legendToggleLabel = mapLegendVisible ? "Hide map legend" : "Show map legend"

  return (
    <>
      <div className="flex flex-col gap-ui-xxs w-full bg-background border outline-2 outline-background h-62 @6xl/main:h-80">
        <Button
          size="icon-sm"
          variant="bland"
          aria-label="Zoom out map"
          disabled={disabled}
          onClick={() => {
            const nextIndex = clampZoomIndex(currentIndex + 1)
            setMapZoomLevelFromControl?.(zoomLevels[nextIndex])
          }}
          className="shrink-0 hover:bg-accent-background border-b"
        >
          <MagnifyingGlassMinusIcon weight="bold" />
        </Button>
        <SliderControl
          orientation="vertical"
          disabled={disabled}
          value={[sliderValue]}
          min={0}
          max={100}
          step={0.1}
          onValueChange={(value) => {
            setMapZoomLevelFromControl?.(sliderValueToZoomLevel(value[0]))
          }}
          className="min-h-0 h-full mx-auto"
        />
        <Button
          variant="bland"
          size="icon-sm"
          aria-label="Zoom in map"
          disabled={disabled}
          onClick={() => {
            const nextIndex = clampZoomIndex(currentIndex - 1)
            setMapZoomLevelFromControl?.(zoomLevels[nextIndex])
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
              aria-label="Reset map"
              disabled={disabled}
              onClick={() => {
                recenterMap?.()
                clearCoursePlot?.()
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
              aria-label={legendToggleLabel}
              disabled={disabled}
              onClick={() => setMapLegendVisible?.(!mapLegendVisible)}
              className="shrink-0 hover:bg-accent-background"
            >
              {mapLegendVisible ?
                <EyeClosedIcon weight="bold" />
              : <EyeIcon weight="bold" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{legendToggleLabel}</TooltipContent>
        </Tooltip>
      </div>
    </>
  )
}
