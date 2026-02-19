import { button, folder, useControls } from "leva"
import { faker } from "@faker-js/faker"

import useGameStore from "@/stores/game"

const COMMODITIES: Resource[] = ["quantum_foam", "retro_organics", "neuro_symbolics"]

const addMockTrade = (isBuy: boolean) => {
  const state = useGameStore.getState()
  const sector = state.sector?.id ?? 1
  const commodity = faker.helpers.arrayElement(COMMODITIES)
  const units = faker.number.int({ min: 1, max: 80 })
  const pricePerUnit = faker.number.int({ min: 5, max: 50 })

  state.addTradeHistoryEntry({
    sector,
    commodity,
    units,
    price_per_unit: pricePerUnit,
    total_price: units * pricePerUnit,
    is_buy: isBuy,
  })
}

export const useTradeControls = () => {
  return useControls(() => ({
    Trade: folder(
      {
        ["Mock Buy Trade"]: button(() => addMockTrade(true)),
        ["Mock Sell Trade"]: button(() => addMockTrade(false)),
      },
      { collapsed: true }
    ),
  }))
}
