import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  ChargingStationIcon,
  LetterCirclePIcon,
  RankingIcon,
  ShippingContainerIcon,
} from "@phosphor-icons/react"

import { BlankSlateTile } from "@/components/BlankSlates"
import {
  SectorHistoryTablePanel,
  TradeHistoryTablePanel,
} from "@/components/panels/DataTablePanels"
import { RHSPanelContent, RHSSubPanel } from "@/components/panels/RHSPanelContainer"
import { RHSPanelList, RHSPanelListItem } from "@/components/panels/RHSPanelList"
import { ShipCatalogue } from "@/components/panels/ShipCatalogue"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import { Input } from "@/components/primitives/Input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Popover"
import { SliderControl } from "@/components/primitives/SliderControl"
import { ChevronSM } from "@/components/svg/ChevronSM"
import { useGameContext } from "@/hooks/useGameContext"
import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import { NeuroSymbolicsIcon, QuantumFoamIcon, RetroOrganicsIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

import { RESOURCE_VERBOSE_NAMES } from "@/types/constants"

const ICON_MAP = {
  quantum_foam: <QuantumFoamIcon size={20} weight="duotone" className="size-6" />,
  retro_organics: <RetroOrganicsIcon size={20} weight="duotone" className="size-6" />,
  neuro_symbolics: <NeuroSymbolicsIcon size={20} weight="duotone" className="size-6" />,
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
        <div className="grid grid-cols-[auto_12px_1fr] gap-y-ui-xs">
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
              <Fragment key={good}>
                <div className="group grid grid-cols-subgrid col-span-3 border">
                  <div
                    className={cn(
                      "relative flex flex-col items-center justify-center border-r corner-dots px-ui-sm gap-2 bg-subtle-background/80",
                      isBuy ? "text-success" : "text-warning"
                    )}
                  >
                    {ICON_MAP[good as Resource]}
                    <span className="text-xxs uppercase text-foreground font-bold">
                      {RESOURCE_VERBOSE_NAMES[good as Resource]}
                    </span>
                    <Popover>
                      <PopoverTrigger asChild>
                        <button className="opacity-0 group-hover:opacity-100 absolute inset-0 bg-background/80 cross-lines-offset-8 cross-lines-terminal-foreground/20 flex items-center justify-center text-xs font-bold text-terminal uppercase">
                          {isBuy ? "Sell" : "Buy"}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="p-ui-sm w-90" side="left">
                        <TradePanelOrderForm commodity={good as Resource} port={port} />
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="dashed-bg-vertical-tight w-[12px] h-full text-accent-background bg-background" />
                  <div
                    className={cn(
                      "flex flex-col min-w-0 divide-y bracket bracket-offset-1",
                      isBuy ? "bracket-success" : "bracket-warning"
                    )}
                  >
                    <div
                      className={cn(
                        "flex flex-1 justify-between items-center text-xs px-ui-sm py-ui-xs"
                      )}
                    >
                      <span
                        className={cn(
                          "text-xxs font-extrabold uppercase w-12 text-center py-px border",
                          isBuy ?
                            "bg-success-background text-success-foreground border-success"
                          : "bg-warning-background text-warning-foreground border-warning"
                        )}
                      >
                        {isBuy ? "BUYS" : "SELLS"}
                      </span>
                      <ChevronSM
                        className={cn(
                          "size-2.5 transition-transform -rotate-90",
                          isBuy ? "text-success" : "text-warning/40"
                        )}
                      />
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
                            "---"
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
              </Fragment>
            )
          })}
        </div>
      : <div className="text-sm text-subtle">No price data available</div>}
    </div>
  )
}

export const TradePanelOrderForm = ({ commodity, port }: { commodity: Resource; port: Port }) => {
  const ship = useGameStore((state) => state.ship)
  const { sendUserTextInput } = useGameContext()
  const portCodeIndex = (Object.keys(port.prices) as Resource[]).indexOf(commodity)
  const portBuys = port.code?.[portCodeIndex] === "B"
  const pricePerUnit = port.prices[commodity] ?? 0

  const maxQuantity = portBuys ? (ship?.cargo?.[commodity] ?? 0) : (port.stock?.[commodity] ?? 0)

  const [quantity, setQuantity] = useState(0)
  const totalPrice = quantity * pricePerUnit

  const handleQuantityChange = useCallback(
    (value: number) => {
      setQuantity(Math.max(0, Math.min(value, maxQuantity)))
    },
    [maxQuantity]
  )

  const handleConfirm = useCallback(() => {
    if (quantity <= 0) return

    sendUserTextInput(
      `Place a ${portBuys ? "SELL" : "BUY"} trade for ${quantity} of ${RESOURCE_VERBOSE_NAMES[commodity]} at ${pricePerUnit} CR per unit`
    )
  }, [quantity, portBuys, commodity, pricePerUnit, sendUserTextInput])

  return (
    <div className="flex flex-col gap-ui-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-ui-xs">
          {ICON_MAP[commodity]}
          <span className="text-xs font-bold uppercase">{RESOURCE_VERBOSE_NAMES[commodity]}</span>
        </div>
        <span
          className={cn(
            "text-xxs font-bold uppercase",
            portBuys ? "text-warning-foreground" : "text-success-foreground"
          )}
        >
          {portBuys ? "SELL" : "BUY"} @ {pricePerUnit} CR
        </span>
      </div>

      <div className="flex flex-row gap-ui-xs">
        <SliderControl
          min={0}
          max={maxQuantity}
          step={1}
          size="lg"
          value={[quantity]}
          onValueChange={(value) => handleQuantityChange(value[0])}
          disabled={maxQuantity === 0}
          className="flex-1"
        />
        <Input
          type="number"
          min={0}
          max={maxQuantity}
          value={quantity}
          onChange={(e) => handleQuantityChange(Number(e.target.value))}
          disabled={maxQuantity === 0}
          className="w-20 text-center appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xxs uppercase text-subtle">
          Total:{" "}
          <span className="font-bold text-foreground">
            {formatCurrency(totalPrice, "standard")} CR
          </span>
        </span>
        <Button size="sm" variant="default" disabled={quantity <= 0} onClick={handleConfirm}>
          {portBuys ? "Sell" : "Buy"} {RESOURCE_VERBOSE_NAMES[commodity]}
        </Button>
      </div>
    </div>
  )
}

export const TradePanel = () => {
  const sector = useGameStore((state) => state.sector)
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()
  const knownPorts = useGameStore((state) => state.known_ports)
  const { isConnected } = usePipecatConnectionState()

  const handleIntent = useCallback(() => {
    const sector = useGameStore.getState().sector
    if (sector?.port) {
      useGameStore.getState().setLookAtTarget("port-" + sector.id.toString())
    }
  }, [])
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
    <div className="w-full h-full" onPointerEnter={handleIntent} onFocusCapture={handleIntent}>
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
                    valueClassName={port?.mega ? "text-terminal" : undefined}
                  />
                  <RHSPanelListItem
                    disabled={!port?.mega}
                    label="Shipyard"
                    value={port?.mega ? "Yes" : "No"}
                    Icon={ShippingContainerIcon}
                    onClick={() => setActiveSubPanel("ship-catalog")}
                  />
                </RHSPanelList>
              </>
            }
          </CardContent>
        </Card>

        {port && (
          <Card size="sm" className="border-0 border-y">
            <CardContent className="flex flex-col gap-ui-sm">
              <TradePanelPortExchange port={port as Port} history={last_observed_data} />
            </CardContent>
          </Card>
        )}

        <Card size="sm" className="border-x-0 border-y flex-1 shrink-0">
          <CardHeader>
            <CardTitle>Trade History</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-row gap-ui-sm pr-0">
            <RHSPanelList>
              <TradeHistoryTablePanel className="max-h-70" />
            </RHSPanelList>
          </CardContent>
        </Card>

        <Card size="sm" className="border-0 border-y">
          <CardHeader>
            <CardTitle>Known Ports</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-ui-sm pr-0">
            <SectorHistoryTablePanel sectorId={sector?.id} className="max-h-70" />
          </CardContent>
        </Card>

        <RHSSubPanel>
          <ShipCatalogue />
        </RHSSubPanel>
      </RHSPanelContent>
    </div>
  )
}
