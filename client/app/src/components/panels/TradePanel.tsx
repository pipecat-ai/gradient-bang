import { useEffect, useMemo, useRef } from "react"

import {
  ChargingStationIcon,
  LetterCirclePIcon,
  RankingIcon,
  ShippingContainerIcon,
} from "@phosphor-icons/react"

import { BlankSlateTile } from "@/components/BlankSlates"
import { SectorHistoryTablePanel } from "@/components/panels/DataTablePanels"
import { RHSPanelContent, RHSSubPanel } from "@/components/panels/RHSPanelContainer"
import { RHSPanelDivider, RHSPanelList, RHSPanelListItem } from "@/components/panels/RHSPanelList"
import { ShipCatalogue } from "@/components/panels/ShipCatalogue"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import { NeuroSymbolicsIcon, QuantumFoamIcon, RetroOrganicsIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { formatTimeAgoOrDate } from "@/utils/date"
import { cn } from "@/utils/tailwind"

import { RESOURCE_VERBOSE_NAMES } from "@/types/constants"

const ICON_MAP = {
  quantum_foam: <QuantumFoamIcon size={20} weight="duotone" className="size-5" />,
  retro_organics: <RetroOrganicsIcon size={20} weight="duotone" className="size-5" />,
  neuro_symbolics: <NeuroSymbolicsIcon size={20} weight="duotone" className="size-5" />,
}

export const TradePanelPortExchange = ({
  port,
  history,
}: {
  port: Port
  history?: SectorHistory
}) => {
  return (
    <div>
      {port.prices ?
        <div className="grid grid-cols-[auto_1fr] gap-y-1">
          {Object.entries(port.prices).map(([good, price], i) => {
            const oldPrice = (history?.sector?.port as Port | undefined)?.prices?.[good as Resource]
            const diffPct =
              oldPrice != null && oldPrice !== 0 ?
                Math.round(((price - oldPrice) / oldPrice) * 100)
              : null
            const stock = port.stock?.[good as Resource]
            const portChar = port.code?.[i]
            const isBuy = portChar === "B"
            return (
              <div key={good} className="col-span-2 grid grid-cols-subgrid border">
                <div className="flex flex-col items-center justify-center corner-dots px-ui-xs gap-1.5 border-r bg-subtle-background/80">
                  {ICON_MAP[good as Resource]}
                  <span className="text-xxs uppercase">
                    {RESOURCE_VERBOSE_NAMES[good as Resource]}
                  </span>
                </div>
                <div className="flex flex-col min-w-0 divide-y">
                  <div
                    className={cn(
                      "flex flex-1 justify-between text-xs px-ui-sm py-ui-xs",
                      isBuy ? "bg-success-background/30" : "bg-warning-background/30"
                    )}
                  >
                    <span
                      className={cn(
                        "text-xs uppercase",
                        isBuy ? "text-success-foreground" : "text-warning-foreground"
                      )}
                    >
                      {isBuy ? "BUYS" : "SELLS"}
                    </span>
                    <div className="flex items-center gap-ui-xs">
                      <div className="text-xxs font-bold uppercase">{price} CR</div>
                      <div
                        className={cn(
                          "text-xxs",
                          diffPct == null || diffPct === 0 ? "text-subtle"
                          : diffPct > 0 ? "text-destructive-foreground"
                          : "text-success-foreground"
                        )}
                      >
                        {diffPct == null || diffPct === 0 ?
                          "0%"
                        : `${diffPct > 0 ? "+" : ""}${diffPct}%`}
                      </div>
                    </div>
                  </div>
                  {stock != null && (
                    <div className="flex flex-1 justify-between text-xs border-accent px-ui-sm py-ui-xs">
                      <span className="uppercase text-subtle">Units in stock</span>
                      <span className="font-semibold">{stock}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      : <div className="text-sm text-subtle">No price data available</div>}
    </div>
  )
}

export const TradePanel = () => {
  const sector = useGameStore((state) => state.sector)
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()
  const knownPorts = useGameStore((state) => state.known_ports)
  const { isConnected } = usePipecatConnectionState()
  const lastFetchRef = useRef<{ sectorId: number | undefined; at: number }>({
    sectorId: undefined,
    at: 0,
  })

  // Derived state
  const port = sector?.port
  const last_observed_data = useMemo(
    () => knownPorts?.find((s) => s.sector.id === sector?.id),
    [knownPorts, sector]
  )

  useEffect(() => {
    if (!isConnected) return

    const sectorChanged = sector?.id !== lastFetchRef.current.sectorId
    const isStale = Date.now() - lastFetchRef.current.at >= 60_000

    if (!sectorChanged && !isStale && knownPorts) return

    console.debug("[GAME TRADE PANEL] Fetching known ports...")
    lastFetchRef.current = { sectorId: sector?.id, at: Date.now() }
    useGameStore.getState().dispatchAction({ type: "get-known-ports" })
  }, [isConnected, sector?.id, knownPorts])

  return (
    <RHSPanelContent>
      <Card size="sm" className="border-0 border-b">
        <CardHeader>
          <CardTitle>Port Info</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-sm pr-0">
          {!port ?
            <BlankSlateTile text="This sector does not have a port" />
          : <>
              <RHSPanelList>
                <RHSPanelListItem label="Code" value={port?.code} Icon={LetterCirclePIcon} />
                <RHSPanelListItem label="Class" value={port?.port_class} Icon={RankingIcon} />
                <RHSPanelListItem
                  label="Refuel Station"
                  disabled={!port?.mega}
                  value={port?.mega ? "Yes" : "No"}
                  Icon={ChargingStationIcon}
                  valueClassName="text-terminal"
                />
                <RHSPanelListItem
                  disabled={!port?.mega}
                  label="Shipyard"
                  value={port?.mega ? "Yes" : "No"}
                  Icon={ShippingContainerIcon}
                  onClick={() => setActiveSubPanel("ship-catalog")}
                />
              </RHSPanelList>

              <div className="text-xxs text-subtle uppercase">
                Last observed:{" "}
                {last_observed_data?.last_visited ?
                  formatTimeAgoOrDate(last_observed_data.last_visited)
                : "Unknown"}
              </div>
            </>
          }
        </CardContent>
      </Card>

      {port && (
        <Card size="sm" className="border-0 border-y">
          <CardHeader>
            <CardTitle>Trade</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-ui-sm pr-0 max-h-70">
            <TradePanelPortExchange port={port as Port} history={last_observed_data} />
            <RHSPanelDivider className="mb-0 h-4" />
          </CardContent>
        </Card>
      )}

      <Card size="sm" className="border-0 border-y">
        <CardHeader>
          <CardTitle>Known Ports</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-sm pr-0 max-h-70">
          <SectorHistoryTablePanel sectorId={sector?.id} />
        </CardContent>
      </Card>
      <RHSSubPanel>
        <ShipCatalogue />
      </RHSSubPanel>
    </RHSPanelContent>
  )
}
