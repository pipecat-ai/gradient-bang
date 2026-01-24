import { produce } from "immer"
import type { StateCreator } from "zustand"

export interface TaskSlice {
  activeTasks: Record<string, ActiveTask>
  taskSummaries: Record<string, TaskSummary>
  corpSlotAssignments: (string | null)[]
  localTaskId: string | null
  taskOutputs: Record<string, TaskOutput[]>
  addTaskOutput: (taskOutput: TaskOutput) => void
  getTaskOutputsByTaskId: (taskId: string) => TaskOutput[]
  removeTaskOutputsByTaskId: (taskId: string) => void
  addActiveTask: (task: ActiveTask) => void
  removeActiveTask: (taskId: string) => void
  addTaskSummary: (taskSummary: TaskSummary) => void
  getTaskSummaryByTaskId: (taskId: string) => TaskSummary | undefined
  getTaskByTaskId: (taskId: string) => ActiveTask | undefined
  setTaskWasCancelled: (taskWasCancelled: boolean) => void
  assignTaskToCorpSlot: (taskId: string) => number | null
  clearCorpSlot: (slotIndex: number) => void
  setLocalTaskId: (taskId: string) => void
}

export const createTaskSlice: StateCreator<TaskSlice> = (set, get) => ({
  activeTasks: {},
  taskSummaries: {},
  taskOutputs: {},
  corpSlotAssignments: [null, null, null],
  localTaskId: null,

  addTaskOutput: (taskOutput: TaskOutput) =>
    set(
      produce((state) => {
        if (!state.taskOutputs[taskOutput.task_id]) {
          state.taskOutputs[taskOutput.task_id] = []
        }
        state.taskOutputs[taskOutput.task_id].push(taskOutput)
      })
    ),

  getTaskOutputsByTaskId: (taskId: string) => get().taskOutputs[taskId] ?? [],
  getTaskOutputs: () => get().taskOutputs,
  removeTaskOutputsByTaskId: (taskId: string) =>
    set(
      produce((state) => {
        delete state.taskOutputs[taskId]
      })
    ),

  addActiveTask: (task: ActiveTask) =>
    set(
      produce((state) => {
        state.activeTasks[task.task_id] = task
        state.taskInProgress = true
      })
    ),

  removeActiveTask: (taskId: string) =>
    set(
      produce((state) => {
        if (taskId in state.activeTasks) {
          delete state.activeTasks[taskId]
        }
        if (Object.keys(state.activeTasks).length === 0) {
          state.taskInProgress = false
        }
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

  assignTaskToCorpSlot: (taskId: string) => {
    const { corpSlotAssignments, activeTasks, taskSummaries } = get()

    // Check if task is already assigned to a slot
    const existingSlot = corpSlotAssignments.indexOf(taskId)
    if (existingSlot !== -1) {
      return existingSlot
    }

    // Find a free slot (null, or task_id not in activeTasks AND not in taskSummaries)
    let freeSlotIndex = -1
    for (let i = 0; i < corpSlotAssignments.length; i++) {
      const slotTaskId = corpSlotAssignments[i]
      if (slotTaskId === null) {
        freeSlotIndex = i
        break
      }
      // Check if the assigned task is neither active nor has a summary (orphaned)
      if (!(slotTaskId in activeTasks) && !(slotTaskId in taskSummaries)) {
        freeSlotIndex = i
        break
      }
    }

    if (freeSlotIndex !== -1) {
      set(
        produce((state) => {
          state.corpSlotAssignments[freeSlotIndex] = taskId
        })
      )
      return freeSlotIndex
    }

    // No free slot - find the oldest completion to overwrite
    // (slot with summary but no active task, sorted by started_at)
    let oldestSlotIndex = -1
    let oldestStartedAt: string | null = null

    for (let i = 0; i < corpSlotAssignments.length; i++) {
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
      set(
        produce((state) => {
          state.corpSlotAssignments[oldestSlotIndex] = taskId
        })
      )
      return oldestSlotIndex
    }

    // All slots have active tasks - cannot assign
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
})
