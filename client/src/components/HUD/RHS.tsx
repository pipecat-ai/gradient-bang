import { CardContent, Divider } from "@pipecat-ai/voice-ui-kit";
import { ConversationPanel } from "../ConversationPanel";
import { ShipOSDPanel } from "../ShipOSDPanel";
import { TaskStatusBadge } from "../TaskStatusBadge";

export const RHS = () => {
  return (
    <div className="w-full h-full rhs-perspective flex">
      <div className="flex flex-col gap-2 w-full h-full ml-auto max-w-[800px]">
        <div className="flex flex-row items-start gap-2 w-full h-full shadow-xlong">
          <div className="flex-shrink-0 self-start">
            <ShipOSDPanel />
          </div>
          <div className="flex-1 h-full flex">
            <ConversationPanel />
          </div>
        </div>
        <CardContent className="mt-auto flex flex-col gap-2">
          <Divider
            size="md"
            childrenClassName="text-xs shrink-0 w-fit opacity-50"
          >
            Task status
          </Divider>
          <TaskStatusBadge />
        </CardContent>
      </div>
    </div>
  );
};
