import { nanoid } from "nanoid";
import type { StateCreator } from "zustand";

export interface TaskSlice {
  taskInProgress: boolean;
  tasks: Task[];
  addTask: (summary: string, type: Task["type"]) => void;
  getTasks: () => Task[];
  setTaskInProgress: (taskInProgress: boolean) => void;
}

export const createTaskSlice: StateCreator<TaskSlice> = (set, get) => ({
  taskInProgress: false,
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
  setTaskInProgress: (taskInProgress: boolean) => set({ taskInProgress }),
});
