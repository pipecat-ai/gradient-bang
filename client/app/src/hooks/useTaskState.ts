import { useMemo } from "react"

import useGameStore from "@/stores/game"

const MAX_CORP_SLOTS = 3

export function useTaskState() {
  const activeTasks = useGameStore.use.activeTasks?.()
  const ships = useGameStore.use.ships?.()
  const localTaskId = useGameStore.use.localTaskId?.()
  const corpSlotAssignments = useGameStore.use.corpSlotAssignments?.()
  const taskHistory = useGameStore.use.task_history?.()
  const dispatchAction = useGameStore.use.dispatchAction?.()

  // Count corporation ships to determine number of corp slots
  const corpShipCount = useMemo(() => {
    return ships.data?.filter((ship) => ship.owner_type === "corporation").length ?? 0
  }, [ships.data])

  // Number of task engines = corp ships capped at 4
  const numTaskEngines = Math.min(Math.max((ships.data?.length ?? 0) - 1, 0), 4)

  // Number of currently active tasks
  const numActiveTasks = Object.keys(activeTasks ?? {}).length

  // Get active local player task
  const activeLocalTask = useMemo(() => {
    const playerTasks = Object.values(activeTasks ?? {}).filter(
      (task) => task?.task_scope === "player_ship"
    )
    return playerTasks[0] ?? null
  }, [activeTasks])

  // Get corp ship tasks
  const corpShipTasks = useMemo(() => {
    return Object.values(activeTasks ?? {}).filter((task) => task?.task_scope === "corp_ship") ?? []
  }, [activeTasks])

  // Displayed corp slots and locked placeholder flag
  const displayedCorpSlots = Math.min(corpShipCount, MAX_CORP_SLOTS)
  const showLockedPlaceholder = corpShipCount < MAX_CORP_SLOTS

  return {
    // Raw store values
    activeTasks,
    ships,
    localTaskId,
    corpSlotAssignments,
    taskHistory,
    dispatchAction,

    // Derived state
    corpShipCount,
    numTaskEngines,
    numActiveTasks,
    activeLocalTask,
    corpShipTasks,
    displayedCorpSlots,
    showLockedPlaceholder,
  }
}
