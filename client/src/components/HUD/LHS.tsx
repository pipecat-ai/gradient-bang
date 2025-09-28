import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@pipecat-ai/voice-ui-kit";
import { GripVerticalIcon } from "lucide-react";
import { useState } from "react";
import { MovementHistoryPanel } from "../MovementHistoryPanel";
import { PanelMenu, type PanelMenuItem } from "../PanelMenu";
import { PortHistoryPanel } from "../PortHistoryPanel";
import { TaskOutputPanel } from "../TaskOutputPanel";
import { TradeHistoryPanel } from "../TradeHistoryPanel";

export const LHS = () => {
  const [currentPanel, setCurrentPanel] =
    useState<PanelMenuItem>("task_output");

  return (
    <div className="w-full lhs-perspective">
      <div className="flex flex-row gap-2 max-w-[800px] h-full">
        <PanelMenu
          currentPanel={currentPanel}
          setCurrentPanel={setCurrentPanel}
        />
        {currentPanel === "task_output" ? (
          <TaskOutputPanel />
        ) : currentPanel === "movement_history" ? (
          <ResizablePanelGroup direction="horizontal" className="gap-2">
            <ResizablePanel minSize={40} defaultSize={60}>
              <MovementHistoryPanel />
            </ResizablePanel>
            <ResizableHandle
              withHandle
              noBorder={false}
              size="md"
              icon={<GripVerticalIcon className="text-white" />}
            />
            <ResizablePanel minSize={30} defaultSize={40}>
              <PortHistoryPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <TradeHistoryPanel />
        )}
      </div>
    </div>
  );
};
