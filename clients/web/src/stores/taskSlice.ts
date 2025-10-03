import { nanoid } from "nanoid";
import type { StateCreator } from "zustand";

export interface Task {
  id: string;
  summary: string;
  timestamp: string;
}

export interface TaskSlice {
  tasks: Task[];
  addTask: (summary: string) => void;
  getTasks: () => Task[];
}

export const createTaskSlice: StateCreator<TaskSlice> = (set, get) => ({
  tasks: [],
  addTask: (summary: string) =>
    set((state) => ({
      tasks: [
        ...state.tasks,
        { summary, id: nanoid(), timestamp: new Date().toISOString() },
      ],
    })),
  getTasks: () => get().tasks,
});
