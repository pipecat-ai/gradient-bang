import { TaskStatusBadge } from "@/components/TaskStatusBadge";
import { TaskOutputStream } from "@hud/TaskOutputStream";

export const TaskOutput = () => {
  return (
    <div className="flex flex-col gap-4 justify-end h-full">
      <TaskOutputStream />
      <TaskStatusBadge />
    </div>
  );
};
