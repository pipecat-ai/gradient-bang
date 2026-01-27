import { button, buttonGroup, folder, useControls } from "leva"
import { faker } from "@faker-js/faker"

import useGameStore from "@/stores/game"

import { SHIP_MOCK } from "@/mocks/ship.mock"
import { TASK_MOCK } from "@/mocks/task.mock"

// Helper to complete a task by ID
const completeTask = (taskId: string | null, status: "completed" | "cancelled" | "failed") => {
  if (!taskId) return
  const state = useGameStore.getState()
  const task = state.activeTasks[taskId]
  if (!task) return

  state.addTaskSummary({
    ...task,
    task_status: status,
    task_summary: faker.lorem.sentence(),
  })
  state.removeActiveTask(taskId)
}

// Helper to add task output
const addOutput = (taskId: string | null) => {
  if (!taskId) return
  const state = useGameStore.getState()
  state.addTaskOutput({
    task_id: taskId,
    text: "task.name: " + faker.lorem.sentence(),
    task_message_type: faker.helpers.arrayElement([
      "STEP",
      "ACTION",
      "EVENT",
      "MESSAGE",
      "COMPLETE",
      "FINISHED",
      "CANCELLED",
      "FAILED",
    ]),
  })
}

export const useTaskControls = () => {
  const localTaskId = useGameStore.use.localTaskId()
  const corpSlotAssignments = useGameStore.use.corpSlotAssignments()
  const setShips = useGameStore.use.setShips()
  const addActiveTask = useGameStore.use.addActiveTask()
  const setLocalTaskId = useGameStore.use.setLocalTaskId()
  const assignTaskToCorpSlot = useGameStore.use.assignTaskToCorpSlot()
  const addMovementHistory = useGameStore.use.addMovementHistory()

  return useControls(
    () => ({
      Task: folder(
        {
          ["Add Local Task"]: button(() => {
            const taskId = faker.string.uuid()
            addActiveTask({
              ...TASK_MOCK,
              task_scope: "player_ship",
              started_at: new Date().toISOString(),
              task_id: taskId,
              task_description: faker.lorem.sentence(),
              actor_character_id: faker.string.uuid(),
              actor_character_name: faker.person.fullName(),
              ship_name: "Local Ship",
              ship_type: "personal",
            })
            setLocalTaskId(taskId)
          }),
          ["Add Corp Task"]: button(() => {
            const ships = useGameStore.getState().ships?.data ?? []
            const corpShips = ships.filter((s) => s.owner_type === "corporation")

            if (corpShips.length === 0) {
              console.warn("No corp ships available. Add a corp ship first.")
              return
            }

            // Pick a random corp ship
            const ship = faker.helpers.arrayElement(corpShips)
            const taskId = faker.string.uuid()

            addActiveTask({
              ...TASK_MOCK,
              task_scope: "corp_ship",
              started_at: new Date().toISOString(),
              task_id: taskId,
              task_description: faker.lorem.sentence(),
              actor_character_id: faker.string.uuid(),
              actor_character_name: faker.person.fullName(),
              ship_id: ship.ship_id,
              ship_name: ship.ship_name,
              ship_type: ship.ship_type,
            })
            assignTaskToCorpSlot(taskId)
          }),
          "Local Slot": folder(
            {
              " ": buttonGroup({
                Output: () => addOutput(localTaskId),
                Complete: () => completeTask(localTaskId, "completed"),
                Cancel: () => completeTask(localTaskId, "cancelled"),
                Fail: () => completeTask(localTaskId, "failed"),
              }),
            },
            { collapsed: false }
          ),
          "Corp Slot 1": folder(
            {
              "  ": buttonGroup({
                Output: () => addOutput(corpSlotAssignments[0]),
                Complete: () => completeTask(corpSlotAssignments[0], "completed"),
                Cancel: () => completeTask(corpSlotAssignments[0], "cancelled"),
                Fail: () => completeTask(corpSlotAssignments[0], "failed"),
              }),
            },
            { collapsed: false }
          ),
          "Corp Slot 2": folder(
            {
              "   ": buttonGroup({
                Output: () => addOutput(corpSlotAssignments[1]),
                Complete: () => completeTask(corpSlotAssignments[1], "completed"),
                Cancel: () => completeTask(corpSlotAssignments[1], "cancelled"),
                Fail: () => completeTask(corpSlotAssignments[1], "failed"),
              }),
            },
            { collapsed: false }
          ),
          "Corp Slot 3": folder(
            {
              "    ": buttonGroup({
                Output: () => addOutput(corpSlotAssignments[2]),
                Complete: () => completeTask(corpSlotAssignments[2], "completed"),
                Cancel: () => completeTask(corpSlotAssignments[2], "cancelled"),
                Fail: () => completeTask(corpSlotAssignments[2], "failed"),
              }),
            },
            { collapsed: false }
          ),
        },
        { collapsed: true }
      ),
      Map: folder(
        {
          ["Add Mock Movement History"]: button(() => {
            addMovementHistory({
              from: 0,
              to: faker.number.int(5000),
              port: faker.datatype.boolean(),
            })
          }),
        },
        { collapsed: true }
      ),
      Ships: folder(
        {
          ["Add Corp Ship"]: button(() => {
            const s = useGameStore.getState().ships ?? []
            setShips([
              ...(s.data ?? []),
              {
                ...SHIP_MOCK,
                ship_id: faker.string.uuid(),
                ship_name: faker.vehicle.vehicle(),
                ship_type: faker.vehicle.type(),
                owner_type: "corporation",
                sector: faker.number.int(5000),
              } as ShipSelf,
            ])
          }),
          ["Reset Ships"]: button(() => {
            setShips([])
          }),
        },
        { collapsed: true }
      ),
    }),
    [localTaskId, corpSlotAssignments]
  )
}
