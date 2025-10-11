import Cassette from "@/components/Cassette";
import { DiscoveredPortsPanel } from "@/components/DiscoveredPortsPanel";
import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { PanelMenu } from "@/components/PanelMenu";
import { TaskOutputPanel } from "@/components/TaskOutputPanel";
import { TradeHistoryPanel } from "@/components/TradeHistoryPanel";
import useGameStore from "@/stores/game";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import {
  Card,
  CardContent,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@pipecat-ai/voice-ui-kit";

export const LHS = () => {
  const panel = useGameStore.use.activePanel?.() || "task_output";
  const setActivePanel = useGameStore.use.setActivePanel();

  return (
    <div className="w-full lhs-perspective">
      <div className="flex flex-row gap-2 max-w-[800px] h-full">
        <PanelMenu currentPanel={panel} setCurrentPanel={setActivePanel} />
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
              <DiscoveredPortsPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : panel === "trade_history" ? (
          <TradeHistoryPanel />
        ) : panel === "debug" ? (
          <Card
            background="scanlines"
            shadow="long"
            withElbows={true}
            className="flex flex-col items-center justify-center [--color-elbow:white] w-full h-full"
          >
            <CardContent>
              <Cassette playing={true} />
            </CardContent>
          </Card>
        ) : (
          <></>
        )}
      </div>
    </div>
  );
};
