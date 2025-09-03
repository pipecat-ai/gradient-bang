import { usePipecatClient } from "@pipecat-ai/client-react";
import { Button, usePipecatConnectionState } from "@pipecat-ai/voice-ui-kit";

import { useEffect, useState } from "react";

import { Footer } from "./Footer";
import { type PanelMenuItem } from "./PanelMenu";
import { ShipOSDPanel } from "./ShipOSDPanel";
import { StarField } from "./StarField";
import { TaskOutputPanel } from "./TaskOutputPanel";

export const App = ({ onConnect }: { onConnect?: () => void }) => {
  const { isConnecting, isConnected } = usePipecatConnectionState();
  const client = usePipecatClient();
  const [currentPanel, setCurrentPanel] =
    useState<PanelMenuItem>("movement_history");

  useEffect(() => {
    if (client && client.state !== "initialized") {
      client.initDevices();
    }
  }, [client]);

  return (
    <>
      <div className="min-h-screen grid grid-rows-[1fr_auto] w-full z-90 relative">
        <main className="flex flex-row p-5 h-[300px] mt-auto">
          {/* Main Game UI*/}
          <div className="w-1/2 lhs-perspective">
            <TaskOutputPanel />
          </div>
          <Button onClick={onConnect}>Connect</Button>
          <div className="w-1/2 rhs-perspective ">
            <ShipOSDPanel />
          </div>
        </main>
        <Footer />
      </div>
      <StarField />
    </>
  );
};
