import { Group, Panel, Separator } from "react-resizable-panels"
import { PipecatClientAudio } from "@pipecat-ai/client-react"

import { Settings } from "@/components/dialogs/Settings"
import { ConversationPanel } from "@/components/panels/ConversationPanel"
import { MiniMapPanel } from "@/components/panels/MiniMapPanel"
import { PlayerShipPanel } from "@/components/panels/PlayerShipPanel"
import { TaskEnginesPanel } from "@/components/panels/TaskEnginesPanel"
import { Divider } from "@/components/primitives/Divider"
import { ScreenContainer } from "@/components/screens/ScreenContainer"
import { Starfield } from "@/components/Starfield"
import { TopBar } from "@/components/TopBar"
import { useNotificationSound } from "@/hooks/useNotificationSound"

import { ToastContainer } from "../toasts/ToastContainer"

export const Game = () => {
  useNotificationSound()

  return (
    <>
      <Group orientation="horizontal" className="relative z-(--z-ui)">
        <Panel className="flex flex-col">
          <TopBar />
          <main className="flex-1 flex flex-col gap-0">
            <div className="p-ui-xs flex-1">
              <TaskEnginesPanel />
            </div>
            <footer className="p-ui-xs pt-0 h-[380px] flex flex-row gap-ui-sm justify-between">
              <ConversationPanel className="flex-1 max-w-xl" />
              <MiniMapPanel className="min-w-[380px]" />
            </footer>
          </main>
        </Panel>
        <Separator className="w-px bg-border outline-white data-[separator=active]:bg-white data-[separator=active]:outline-1 data-[separator=hover]:bg-subtle z-90" />
        <Panel collapsible maxSize="50%" defaultSize="480px" minSize="400px">
          <aside className="h-full border-background border-l-(length:--seperator) flex flex-col">
            <header className="pb-(--seperator) flex flex-col gap-(--seperator) bg-black">
              <PlayerShipPanel />
              <Divider className="bg-accent-background" />
            </header>
            <div className="border-l border-t flex-1 bg-black/40 flex flex-col items-center justify-center">
              WIP
            </div>
          </aside>
        </Panel>
      </Group>

      {/* Sub-screens (trading, ship, messaging, etc..) */}
      <ScreenContainer />

      {/* Other Renderables */}
      <ToastContainer />
      <Starfield />
      <Settings />
      <PipecatClientAudio />
    </>
  )
}

export default Game
