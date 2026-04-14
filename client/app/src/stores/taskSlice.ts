import { produce } from "immer"
import type { StateCreator } from "zustand"

import { wait } from "@/utils/animation"
import { ACTIVE_PANEL_REST_SECS } from "./uiSlice"
import type { UISlice } from "./uiSlice"

// Duration of the "Steering" badge flash, in milliseconds. When the voice
// agent sends a steering instruction to a running task, the badge briefly
// flashes a "Steering" label before returning to its normal active state.
export const STEERING_FLASH_MS = 3000

export interface TaskSlice {
  activeTasks: Record<string, ActiveTask>
  taskSummaries: Record<string, TaskSummary>
  corpSlotAssignments: (string | null)[]
  localTaskId: string | null
  taskOutputs: Record<string, TaskOutput[]>
  // task_id → epoch-ms timestamp when the current steering flash window ends.
  // Absence means "not currently being steered". Entries are cleared by the
  // markTaskSteering async cleanup phase or by removeActiveTask, whichever
  // fires first.
  steeringExpiresAt: Record<string, number>
  addTaskOutput: (taskOutput: TaskOutput) => void
  getTaskOutputsByTaskId: (taskId: string) => TaskOutput[]
  removeTaskOutputsByTaskId: (taskId: string) => void
  addActiveTask: (task: ActiveTask) => void
  removeActiveTask: (taskId: string) => void
  addTaskSummary: (taskSummary: TaskSummary) => void
  getTaskSummaryByTaskId: (taskId: string) => TaskSummary | undefined
  getTaskByTaskId: (taskId: string) => ActiveTask | undefined
  setTaskWasCancelled: (taskWasCancelled: boolean) => void
  assignTaskToCorpSlot: (taskId: string, maxSlots?: number) => number | null
  clearCorpSlot: (slotIndex: number) => void
  setLocalTaskId: (taskId: string) => void
  markTaskSteering: (taskId: string) => Promise<void>
}

export const createTaskSlice: StateCreator<TaskSlice> = (set, get) => ({
  activeTasks: {},
  taskSummaries: {},
  taskOutputs: {},
  steeringExpiresAt: {},
  corpSlotAssignments: [null, null, null],
  localTaskId: null,

  addTaskOutput: (taskOutput: TaskOutput) => {
    set((state) => {
      const existing = state.taskOutputs[taskOutput.task_id] ?? []

      // Merge consecutive THINKING messages into a single entry
      const incomingType = taskOutput.task_message_type.toUpperCase()
      const lastType =
        existing.length > 0 ? existing[existing.length - 1].task_message_type.toUpperCase() : ""
      if (incomingType === "THINKING" && lastType === "THINKING") {
        const merged = [...existing]
        const last = merged[merged.length - 1]
        merged[merged.length - 1] = { ...last, text: last.text + taskOutput.text }
        return {
          taskOutputs: { ...state.taskOutputs, [taskOutput.task_id]: merged },
        }
      }

      const updated = [...existing, taskOutput]
      return {
        taskOutputs: {
          ...state.taskOutputs,
          [taskOutput.task_id]: updated.length > 200 ? updated.slice(-200) : updated,
        },
      }
    })

    // A STEERING-typed task_output is the signal that the voice agent
    // routed a new instruction into a running task. Fire-and-forget the
    // flash-window action so the badge briefly shows a "Steering" label.
    if (taskOutput.task_message_type.toUpperCase() === "STEERING") {
      void get().markTaskSteering(taskOutput.task_id)
    }
  },

  getTaskOutputsByTaskId: (taskId: string) => get().taskOutputs[taskId] ?? [],
  getTaskOutputs: () => get().taskOutputs,
  removeTaskOutputsByTaskId: (taskId: string) =>
    set(
      produce((state) => {
        delete state.taskOutputs[taskId]
      })
    ),

  addActiveTask: (task: ActiveTask) => {
    set(
      produce((state) => {
        state.activeTasks[task.task_id] = task
        state.taskInProgress = true
        if (task.task_scope === "player_ship") {
          state.localTaskId = task.task_id
        }
      })
    )
    if (task.task_scope === "corp_ship") {
      const ships = (get() as unknown as Record<string, unknown>).ships as {
        data?: ShipSelf[]
      }
      const corpShipCount =
        ships.data?.filter((ship) => ship.owner_type === "corporation").length ?? 0
      const maxSlots = Math.min(corpShipCount, 3)
      get().assignTaskToCorpSlot(task.task_id, maxSlots)
    }

    if (task.task_scope === "player_ship") {
      const ui = get() as unknown as UISlice
      const idle = Date.now() - ui.lastPanelInteractionAt > ACTIVE_PANEL_REST_SECS * 1000
      if (ui.uiMode === "map" && idle) {
        ui.focusTaskStreamPanel(task.task_id)
      }
    }
  },

  removeActiveTask: (taskId: string) =>
    set(
      produce((state) => {
        if (taskId in state.activeTasks) {
          delete state.activeTasks[taskId]
        }
        if (Object.keys(state.activeTasks).length === 0) {
          state.taskInProgress = false
        }
        // Clear any in-flight steering flash: the task is over, the badge
        // must flip straight to its terminal state rather than linger on
        // "Steering" for the remainder of the flash window.
        delete state.steeringExpiresAt[taskId]
      })
    ),

  addTaskSummary: (taskSummary: TaskSummary) =>
    set(
      produce((state) => {
        state.taskSummaries[taskSummary.task_id] = taskSummary
      })
    ),

  getTaskSummaryByTaskId: (taskId: string) => get().taskSummaries[taskId] ?? undefined,

  getTaskByTaskId: (taskId: string) => get().activeTasks[taskId] ?? undefined,

  setTaskWasCancelled: (taskWasCancelled: boolean) =>
    set(
      produce((state) => {
        state.taskWasCancelled = taskWasCancelled
      })
    ),

  assignTaskToCorpSlot: (taskId: string, maxSlots?: number) => {
    const { corpSlotAssignments, activeTasks, taskSummaries } = get()

    // Limit slots to maxSlots if provided (based on unlocked corp ships)
    const slotLimit = maxSlots ?? corpSlotAssignments.length

    // Check if task is already assigned to a slot (within the limit)
    const existingSlot = corpSlotAssignments.indexOf(taskId)
    if (existingSlot !== -1 && existingSlot < slotLimit) {
      return existingSlot
    }

    // Find a free slot (null, or task_id not in activeTasks AND not in taskSummaries)
    let freeSlotIndex = -1
    let previousTaskId: string | null = null
    for (let i = 0; i < slotLimit; i++) {
      const slotTaskId = corpSlotAssignments[i]
      if (slotTaskId === null) {
        freeSlotIndex = i
        break
      }
      // Check if the assigned task is neither active nor has a summary (orphaned)
      if (!(slotTaskId in activeTasks) && !(slotTaskId in taskSummaries)) {
        freeSlotIndex = i
        previousTaskId = slotTaskId
        break
      }
    }

    if (freeSlotIndex !== -1) {
      set(
        produce((state) => {
          // Clean up outputs from the previous task before reusing slot
          if (previousTaskId) {
            delete state.taskOutputs[previousTaskId]
          }
          state.corpSlotAssignments[freeSlotIndex] = taskId
        })
      )
      return freeSlotIndex
    }

    // No free slot - find the oldest completion to overwrite
    // (slot with summary but no active task, sorted by started_at)
    let oldestSlotIndex = -1
    let oldestStartedAt: string | null = null

    for (let i = 0; i < slotLimit; i++) {
      const slotTaskId = corpSlotAssignments[i]
      if (slotTaskId === null) continue

      // Skip if task is still active
      if (slotTaskId in activeTasks) continue

      // Check if it has a summary (completion state)
      const summary = taskSummaries[slotTaskId]
      if (summary) {
        if (oldestStartedAt === null || summary.started_at < oldestStartedAt) {
          oldestStartedAt = summary.started_at
          oldestSlotIndex = i
        }
      }
    }

    if (oldestSlotIndex !== -1) {
      const previousTaskId = corpSlotAssignments[oldestSlotIndex]
      set(
        produce((state) => {
          // Clean up outputs and summary from the previous task before reusing slot
          if (previousTaskId) {
            delete state.taskOutputs[previousTaskId]
            delete state.taskSummaries[previousTaskId]
          }
          state.corpSlotAssignments[oldestSlotIndex] = taskId
        })
      )
      return oldestSlotIndex
    }

    // All unlocked slots have active tasks - cannot assign
    console.warn(
      `[TaskSlice] Cannot assign task ${taskId}: all ${slotLimit} unlocked slot(s) are occupied`
    )
    return null
  },

  clearCorpSlot: (slotIndex: number) =>
    set(
      produce((state) => {
        if (slotIndex >= 0 && slotIndex < state.corpSlotAssignments.length) {
          state.corpSlotAssignments[slotIndex] = null
        }
      })
    ),

  setLocalTaskId: (taskId: string) =>
    set(
      produce((state) => {
        state.localTaskId = taskId
      })
    ),

  markTaskSteering: async (taskId: string) => {
    // Stamp the flash window. A second call within the window writes a
    // newer expiresAt; the older call's cleanup phase below then becomes
    // a no-op because `current !== expiresAt`.
    const expiresAt = Date.now() + STEERING_FLASH_MS
    set(
      produce((state) => {
        state.steeringExpiresAt[taskId] = expiresAt
      })
    )

    await wait(STEERING_FLASH_MS)

    // If a newer markTaskSteering extended the window, leave cleanup to
    // that call. If removeActiveTask cleared the entry because the task
    // finished mid-flash, the delete below is a harmless no-op on a
    // missing key.
    const current = get().steeringExpiresAt[taskId]
    if (current !== expiresAt) return
    set(
      produce((state) => {
        delete state.steeringExpiresAt[taskId]
      })
    )
  },
})
