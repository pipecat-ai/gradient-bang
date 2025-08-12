import {
  Button,
  Card,
  Divider,
  GripIcon,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@pipecat-ai/voice-ui-kit";

import { useState } from "react";

import { RTVIEvent } from "@pipecat-ai/client-js";
import { useRTVIClientEvent } from "@pipecat-ai/client-react";
import { ControlBar } from "./ControlBar";
import { ConversationPanel } from "./ConversationPanel";
import { DebugPanel } from "./DebugPanel";
import { Footer } from "./Footer";
import { ImagePanel } from "./ImagePanel";
import { MovementHistoryPanel } from "./MovementHistoryPanel";
import { PanelMenu } from "./PanelMenu";
import { PortHistoryPanel } from "./PortHistoryPanel";
import { ShipPanel } from "./ShipPanel";
import { StartScreen } from "./StartScreen";
import { TaskOutputPanel } from "./TaskOutputPanel";

export const App = ({ onConnect }: { onConnect?: () => void }) => {
  const [connectedState, setConnectedState] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [currentPanel, setCurrentPanel] = useState<
    "movement" | "port" | "debug"
  >("movement");

  useRTVIClientEvent(RTVIEvent.TransportStateChanged, (newState) => {
    switch (newState) {
      case "ready":
        setConnectedState("connected");
        break;
      case "connecting":
      case "authenticating":
      case "authenticated":
        setConnectedState("connecting");
        break;
      default:
        setConnectedState("disconnected");
        break;
    }
  });

  return (
    <div className="min-h-screen grid grid-rows-[1fr_auto] w-full vkui:bg-background">
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
              {["disconnected", "connecting"].includes(connectedState) ? (
                <StartScreen>
                  <Button
                    variant={
                      connectedState === "connecting" ? "default" : "active"
                    }
                    loader="stripes"
                    onClick={onConnect}
                    isLoading={connectedState === "connecting"}
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
              {currentPanel === "movement" ? (
                <MovementHistoryPanel />
              ) : currentPanel === "port" ? (
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
    </div>
  );
};
