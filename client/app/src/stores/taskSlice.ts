import { produce } from "immer"
import { nanoid } from "nanoid"
import type { StateCreator } from "zustand"

export interface TaskSlice {
  taskInProgress: boolean
  taskWasCancelled: boolean
  tasks: Task[]
  activeTasks: Record<string, ActiveTask>
  addTask: (summary: string, type: Task["type"]) => void
  getTasks: () => Task[]
  addActiveTask: (task: ActiveTask) => void
  removeActiveTask: (taskId: string) => void
  setTaskInProgress: (taskInProgress: boolean) => void
  setTaskWasCancelled: (taskWasCancelled: boolean) => void
}

export interface ActiveTask {
  task_id: string
  task_description?: string
  started_at: string
  actor_character_id?: string
  actor_character_name?: string
  task_scope?: "player_ship" | "corp_ship"
  ship_id?: string
  ship_name?: string | null
  ship_type?: string | null
}

export const createTaskSlice: StateCreator<TaskSlice> = (set, get) => ({
  taskInProgress: false,
  taskWasCancelled: false,
  tasks: [],
  activeTasks: {},
  addTask: (summary: string, type: Task["type"]) =>
    set(
      produce((state) => {
        state.tasks.push({
          summary,
          id: nanoid(),
          type: type.toUpperCase() as TaskType,
          timestamp: new Date().toISOString(),
        })
      })
    ),
  getTasks: () => get().tasks,
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
  setTaskInProgress: (taskInProgress: boolean) =>
    taskInProgress
      ? set({ taskInProgress, taskWasCancelled: false })
      : set({ taskInProgress }),
  setTaskWasCancelled: (taskWasCancelled: boolean) => set({ taskWasCancelled }),
})
