import { nanoid } from "nanoid";
import type { StateCreator } from "zustand";

export interface Task {
  id: string;
  summary: string;
  timestamp: string;
}

export interface TaskSlice {
  taskInProgress: boolean;
  tasks: Task[];
  addTask: (summary: string) => void;
  getTasks: () => Task[];
  setTaskInProgress: (taskInProgress: boolean) => void;
}

export const createTaskSlice: StateCreator<TaskSlice> = (set, get) => ({
  taskInProgress: false,
  tasks: [],
  addTask: (summary: string) =>
    set((state) => ({
      tasks: [
        ...state.tasks,
        { summary, id: nanoid(), timestamp: new Date().toISOString() },
      ],
    })),
  getTasks: () => get().tasks,
  setTaskInProgress: (taskInProgress: boolean) => set({ taskInProgress }),
});
