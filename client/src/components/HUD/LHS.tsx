import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@pipecat-ai/voice-ui-kit";
import { GripVerticalIcon } from "lucide-react";
import { useState } from "react";
import { MovementHistoryPanel } from "../MovementHistoryPanel";
import { HudMapVisualization } from "../HudMapVisualization";
import { PanelMenu, type PanelMenuItem } from "../PanelMenu";
import { PortHistoryPanel } from "../PortHistoryPanel";
import { TaskOutputPanel } from "../TaskOutputPanel";
import { TradeHistoryPanel } from "../TradeHistoryPanel";

export const LHS = () => {
  const [currentPanel, setCurrentPanel] =
    useState<PanelMenuItem>("task_output");

  return (
    <div className="w-full h-full lhs-perspective flex">
      <div
        className="flex flex-col gap-3 max-w-[800px] flex-1"
        style={{ minHeight: "clamp(560px, 75vh, 820px)" }}
      >
        <div
          className="relative w-full shrink-0 border border-white/10 bg-black/40 backdrop-blur-sm shadow-xlong"
          style={{ aspectRatio: "1 / 1" }}
        >
          <HudMapVisualization />
        </div>
        <div className="flex flex-row gap-2 flex-1 min-h-0">
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
    </div>
  );
};
