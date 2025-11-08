import { ConversationPanel } from "@/components/ConversationPanel";
import { PanelMenu } from "@/components/PanelMenu";
import { ShipOSDPanel } from "@/components/ShipOSDPanel";
import { TaskOutputPanel } from "@/components/TaskOutputPanel";
import { useGameContext } from "@/hooks/useGameContext";
import useGameStore from "@/stores/game";
import {
  CardContent,
  Divider,
  TextInput,
  UserAudioControl,
} from "@pipecat-ai/voice-ui-kit";

export const RHS = () => {
  const panel = useGameStore.use.activePanel?.() || "conversation";
  const setActivePanel = useGameStore.use.setActivePanel();

  const { sendUserTextInput } = useGameContext();
  return (
    <div className="w-full rhs-perspective">
      <div className="flex flex-row gap-2 w-full h-full ml-auto max-w-[700px] justify-end">
        {panel === "conversation" ? (
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
              <UserAudioControl size="lg" variant="outline" />
              <TextInput
                onSend={(text) => {
                  sendUserTextInput?.(text);
                }}
              />
            </CardContent>
          </div>
        ) : (
          <TaskOutputPanel />
        )}
        <PanelMenu currentPanel={panel} setCurrentPanel={setActivePanel} />
      </div>
    </div>
  );
};
