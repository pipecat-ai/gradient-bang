import { button, folder, useControls } from "leva"
import { faker } from "@faker-js/faker"

import useGameStore from "@/stores/game"

import {
  LARGE_MAP_DATA_MOCK,
  MEDIUM_MAP_DATA_MOCK,
  MOCK_COURSE_PLOT,
  SMALL_MAP_DATA_MOCK,
} from "@/mocks/map.mock"

export const useMapControls = () => {
  const addMovementHistory = useGameStore.use.addMovementHistory()
  const setRegionalMapData = useGameStore.use.setRegionalMapData()
  const setLocalMapData = useGameStore.use.setLocalMapData()
  const setCoursePlot = useGameStore.use.setCoursePlot()
  const clearCoursePlot = useGameStore.use.clearCoursePlot()

  return useControls(() => ({
    Map: folder({
      ["Set Course Plot"]: button(() => {
        setCoursePlot(MOCK_COURSE_PLOT)
      }),
      ["Clear Course Plot"]: button(() => {
        clearCoursePlot()
      }),
      ["Add Mock Movement History"]: button(() => {
        addMovementHistory({
          from: 0,
          to: faker.number.int(5000),
          port: faker.datatype.boolean(),
        })
      }),
      ["Load Small Mock"]: button(() => {
        setRegionalMapData(SMALL_MAP_DATA_MOCK)
        setLocalMapData(SMALL_MAP_DATA_MOCK)
      }),
      ["Load Medium Mock"]: button(() => {
        setRegionalMapData(MEDIUM_MAP_DATA_MOCK)
        setLocalMapData(MEDIUM_MAP_DATA_MOCK)
      }),
      ["Load Large Mock"]: button(() => {
        setRegionalMapData(LARGE_MAP_DATA_MOCK)
      }),
    }),
  }))
}
