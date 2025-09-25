import { create } from "zustand";

export interface TaskOutput {
  id: string;
  task_message_type?: string;
  text?: string;
  timestamp: string;
}

export type TaskStatus = "cancelled" | "completed" | "paused" | "failed";

interface TaskState {
  tasks: TaskOutput[];
  active: boolean;
  status?: TaskStatus;
  addTaskOutput: (taskOutput: TaskOutput) => void;
  getTasks: () => TaskOutput[];
  setActive: (active: boolean) => void;
  setStatus: (status: TaskStatus | undefined) => void;
}

const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  active: false,
  status: undefined,
  addTaskOutput: (taskOutput: TaskOutput) =>
    set((state) => ({ tasks: [...state.tasks, taskOutput] })),
  getTasks: () => get().tasks,
  setActive: (active: boolean) => set({ active }),
  setStatus: (status: TaskStatus | undefined) => set({ status }),
}));

export default useTaskStore;
