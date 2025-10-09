import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { PanelMenu } from "@/components/PanelMenu";
import { PortHistoryPanel } from "@/components/PortHistoryPanel";
import { TaskOutputPanel } from "@/components/TaskOutputPanel";
import { TradeHistoryPanel } from "@/components/TradeHistoryPanel";
import { Debug } from "@/debug/Debug";
import useGameStore from "@/stores/game";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@pipecat-ai/voice-ui-kit";

export const LHS = () => {
  const { panel } = useGameStore.use.ui();
  const setPanel = useGameStore.use.setPanel();

  return (
    <div className="w-full lhs-perspective">
      <div className="flex flex-row gap-2 max-w-[800px] h-full">
        <PanelMenu currentPanel={panel} setCurrentPanel={setPanel} />
        {panel === "task_output" ? (
          <TaskOutputPanel />
        ) : panel === "movement_history" ? (
          <ResizablePanelGroup direction="horizontal" className="gap-2">
            <ResizablePanel minSize={40} defaultSize={60}>
              <MovementHistoryPanel />
            </ResizablePanel>
            <ResizableHandle
              withHandle
              noBorder={false}
              size="md"
              icon={
                <DotsSixVerticalIcon weight="bold" className="text-white" />
              }
            />
            <ResizablePanel minSize={30} defaultSize={40}>
              <PortHistoryPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : panel === "trade_history" ? (
          <TradeHistoryPanel />
        ) : panel === "debug" ? (
          <Debug
            messages={[
              [
                "Hop to sector 0",
                "Navigate and move to sector 0 immediately. If it's not adjacent to our current sector, plot the shortest path and start moving without asking me.",
              ],
              [
                "Hop to a random adjacent sector",
                "Pick one random adjacent sector and move to it immediately.",
              ],
              [
                "Hop 3 adjacent sectors",
                "Plot a course to a randomsector 2-3 hops away from our current position and move to it immediately. Do not hop more than 3 times.",
              ],
            ]}
          />
        ) : (
          <></>
        )}
      </div>
    </div>
  );
};
