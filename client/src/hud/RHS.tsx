import { ConversationPanel } from "@/components/ConversationPanel";
import { ShipOSDPanel } from "@/components/ShipOSDPanel";
import { TaskStatusBadge } from "@/components/TaskStatusBadge";
import { CardContent, Divider } from "@pipecat-ai/voice-ui-kit";

export const RHS = () => {
  return (
    <div className="w-full rhs-perspective">
      <div className="flex flex-col gap-2 w-full h-full ml-auto max-w-[800px]">
        <div className="flex flex-row gap-2 w-full h-full shadow-xlong">
          <ShipOSDPanel />
          <ConversationPanel />
        </div>
        <CardContent className="mt-auto flex flex-col gap-2">
          <Divider
            size="md"
            childrenClassName="text-xs shrink-0 w-fit opacity-50 uppercase"
          >
            Task status
          </Divider>
          <TaskStatusBadge />
        </CardContent>
      </div>
    </div>
  );
};
