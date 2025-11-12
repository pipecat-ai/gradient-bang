import { ConversationPanel } from "@/components/ConversationPanel";
import { ShipOSDPanel } from "@/components/ShipOSDPanel";
import { useGameContext } from "@/hooks/useGameContext";
import { CardContent, Divider } from "@pipecat-ai/voice-ui-kit";
import { TextInputControl } from "../TextInputControl";
import { UserMicControl } from "../UserMicControl";
import { Separator } from "../primitives/Separator";

export const RHS = () => {
  const { sendUserTextInput } = useGameContext();
  return (
    <div className="w-full rhs-perspective">
      <div className="flex flex-row gap-2 w-full h-full ml-auto justify-end">
        <div className="flex flex-col gap-2 flex-1">
          <div className="flex flex-row gap-3 w-full h-full shadow-xlong">
            <ShipOSDPanel />
            <ConversationPanel />
          </div>
          <CardContent className="mt-auto flex flex-col gap-2">
            <Divider
              size="md"
              childrenClassName="text-xs shrink-0 w-fit opacity-50 uppercase"
            >
              Input controls
            </Divider>
            <div className="flex flex-row gap-2">
              <TextInputControl
                onSend={(text) => {
                  sendUserTextInput?.(text);
                }}
              />
              <Separator orientation="vertical" />
              <UserMicControl className="min-w-32" />
            </div>
          </CardContent>
        </div>
      </div>
    </div>
  );
};
