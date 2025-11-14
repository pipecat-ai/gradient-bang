import { nanoid } from "nanoid";
import type { StateCreator } from "zustand";

export interface TaskSlice {
  taskInProgress: boolean;
  taskWasCancelled: boolean;
  tasks: Task[];
  addTask: (summary: string, type: Task["type"]) => void;
  getTasks: () => Task[];
  setTaskInProgress: (taskInProgress: boolean) => void;
  setTaskWasCancelled: (taskWasCancelled: boolean) => void;
}

export const createTaskSlice: StateCreator<TaskSlice> = (set, get) => ({
  taskInProgress: false,
  taskWasCancelled: false,
  tasks: [],
  addTask: (summary: string, type: Task["type"]) =>
    set((state) => ({
      tasks: [
        ...state.tasks,
        {
          summary,
          id: nanoid(),
          type: type.toUpperCase() as TaskType,
          timestamp: new Date().toISOString(),
        },
      ],
    })),
  getTasks: () => get().tasks,
  setTaskInProgress: (taskInProgress: boolean) =>
    taskInProgress
      ? set({ taskInProgress, taskWasCancelled: false })
      : set({ taskInProgress }),
  setTaskWasCancelled: (taskWasCancelled: boolean) => set({ taskWasCancelled }),
});
