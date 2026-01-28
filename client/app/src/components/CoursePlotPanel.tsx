import { useMemo } from "react"

import { ArrowFatRightIcon, CompassIcon } from "@phosphor-icons/react"

import { PanelTitle } from "@/components/PanelTitle"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"
import { calculateHopsRemaining } from "@/utils/game"
import { cn } from "@/utils/tailwind"

export const CoursePlotPanel = () => {
  const coursePlot = useGameStore.use.course_plot?.()
  const clearCoursePlot = useGameStore.use.clearCoursePlot?.()
  const sector = useGameStore((state) => state.sector)

  const hopsRemaining = useMemo(
    () => calculateHopsRemaining(sector, coursePlot),
    [sector, coursePlot]
  )

  return (
    <Card
      variant="stripes"
      size="sm"
      className={cn(
        "",
        coursePlot ? "bg-fuel-background/50 stripe-frame-fuel" : "stripe-frame-white/30"
      )}
    >
      <CardContent className="h-24 flex flex-col justify-center items-center">
        {coursePlot ?
          <div className="flex flex-col gap-3 justify-between h-full w-full">
            <div className="flex flex-row gap-3 items-center justify-between w-full h-full">
              <div className="flex shrink-0 flex-1 flex-col gap-1 bg-fuel-background h-full items-center justify-center">
                <span className="text-xs uppercase font-bold tracking-widest">From</span>
                <span className="text-lg font-bold text-fuel-foreground leading-none">
                  {coursePlot.from_sector}
                </span>
              </div>
              <ArrowFatRightIcon weight="duotone" size={24} className="text-fuel" />
              <div className="flex flex-col gap-1">
                <span className="text-xs uppercase font-bold tracking-widest animate-pulse">
                  {hopsRemaining} Hops
                </span>
              </div>
              <ArrowFatRightIcon weight="duotone" size={24} className="text-fuel" />
              <div className="flex shrink-0 flex-1 flex-col gap-1 bg-fuel-background h-full items-center justify-center">
                <span className="text-xs uppercase font-bold tracking-widest">To</span>
                <span className="text-lg font-bold text-fuel-foreground leading-none">
                  {coursePlot.to_sector}
                </span>
              </div>
            </div>
            <Button
              onClick={clearCoursePlot}
              size="sm"
              variant="secondary"
              className="w-full text-xs border-transparent"
            >
              Clear course plot
            </Button>
          </div>
        : <div className="text-center text-xs flex flex-col gap-3 items-center ">
            <CompassIcon size={32} weight="duotone" className="opacity-30" />
            <PanelTitle>No active course plot</PanelTitle>
          </div>
        }
      </CardContent>
    </Card>
  )
}
