import {
  Button,
  Card,
  Divider,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePipecatConnectionState,
} from "@pipecat-ai/voice-ui-kit";

import { useEffect, useState } from "react";

import { usePipecatClient } from "@pipecat-ai/client-react";
import { GripIcon } from "lucide-react";
import { ControlBar } from "./ControlBar";
import { ConversationPanel } from "./ConversationPanel";
import { DebugPanel } from "./DebugPanel";
import { Footer } from "./Footer";
import { HighlightOverlay } from "./HighlightOverlay";
import { ImagePanel } from "./ImagePanel";
import { MovementHistoryPanel } from "./MovementHistoryPanel";
import { PanelMenu, type PanelMenuItem } from "./PanelMenu";
import { PortHistoryPanel } from "./PortHistoryPanel";
import { ShipPanel } from "./ShipPanel";
import { StartScreen } from "./StartScreen";
import { TaskOutputPanel } from "./TaskOutputPanel";

export const App = ({ onConnect }: { onConnect?: () => void }) => {
  const { isConnecting, isConnected } = usePipecatConnectionState();
  const client = usePipecatClient();
  const [currentPanel, setCurrentPanel] =
    useState<PanelMenuItem>("movement_history");

  useEffect(() => {
    if (client) {
      client.initDevices();
    }
  }, [client]);

  console.log("AAA", isConnecting, isConnected);

  return (
    <div className="min-h-screen grid grid-rows-[1fr_auto] w-full bg-background">
      <main className="flex flex-col overflow-y-scroll h-full">
        {/* Main Game UI*/}
        <div className="grid grid-cols-[var(--width-image)_auto] gap-panel p-panel flex-1">
          {/* Image Panel - Display is managed by the GameContext (setImage) */}
          <ImagePanel />
          {/* Console - Conversation and Input Controls */}
          <section
            id="console"
            className="flex-1 flex flex-col justify-center items-center gap-panel min-h-0"
          >
            <Card background="stripes" className="flex-1 w-full">
              {!isConnected ? (
                <StartScreen>
                  <Button
                    variant={isConnecting ? "primary" : "active"}
                    loader="stripes"
                    onClick={onConnect}
                    isLoading={isConnecting}
                  >
                    INITIATE PROTOCOL
                  </Button>
                </StartScreen>
              ) : (
                <ConversationPanel />
              )}
            </Card>
            <ControlBar />
          </section>
        </div>

        <Divider className="w-full py-1" variant="dotted" />

        {/* User Controls & Game Text*/}
        <div className="grid grid-cols-[var(--width-shippanel)_auto] gap-panel p-panel h-[var(--height-bottombar)]">
          <ShipPanel />
          <ResizablePanelGroup direction="horizontal" className="gap-2">
            <ResizablePanel minSize={40} defaultSize={60}>
              <TaskOutputPanel />
            </ResizablePanel>
            <ResizableHandle
              withHandle
              noBorder={false}
              size="md"
              icon={<GripIcon className="rotate-90" />}
              className="w-10"
            />
            <ResizablePanel minSize={30} defaultSize={40}>
              {currentPanel === "movement_history" ? (
                <MovementHistoryPanel />
              ) : currentPanel === "ports_discovered" ? (
                <PortHistoryPanel />
              ) : (
                <DebugPanel />
              )}
            </ResizablePanel>
            <PanelMenu
              currentPanel={currentPanel}
              setCurrentPanel={setCurrentPanel}
            />
          </ResizablePanelGroup>
        </div>
      </main>
      <Footer />

      <HighlightOverlay />
    </div>
  );
};
