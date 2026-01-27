import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels"
import { ArrowLeftIcon } from "@phosphor-icons/react"
import { PipecatClientAudio } from "@pipecat-ai/client-react"

import { Settings } from "@/components/dialogs/Settings"
import { ConversationPanel } from "@/components/panels/ConversationPanel"
import { MiniMapPanel } from "@/components/panels/MiniMapPanel"
import { PlayerShipPanel } from "@/components/panels/PlayerShipPanel"
import { RHSPanelContainer } from "@/components/panels/RHSPanelContainer"
import { RHSPanelNav } from "@/components/panels/RHSPanelNav"
import { TaskEnginesPanel } from "@/components/panels/TaskEnginesPanel"
import { Divider } from "@/components/primitives/Divider"
import { ScreenContainer } from "@/components/screens/ScreenContainer"
import { SectorTitleBanner } from "@/components/SectorTitleBanner"
import { Starfield } from "@/components/Starfield"
import { ToastContainer } from "@/components/toasts/ToastContainer"
import { TopBar } from "@/components/TopBar"
import { useNotificationSound } from "@/hooks/useNotificationSound"

import { Button } from "../primitives/Button"

export const Game = () => {
  useNotificationSound()
  const asidePanelRef = usePanelRef()

  return (
    <>
      <Group orientation="horizontal" className="relative z-(--z-ui)">
        <Panel className="flex flex-col">
          <TopBar />
          <main className="flex-1 flex flex-col gap-0">
            <SectorTitleBanner />

            <div className="p-ui-xs flex-1">
              <TaskEnginesPanel />
            </div>
            <footer className="p-ui-xs pt-0 h-[330px] flex flex-row gap-ui-sm justify-between">
              <ConversationPanel className="flex-1 max-w-xl" />
              <MiniMapPanel className="min-w-[330px]" />
            </footer>
          </main>
        </Panel>
        <Separator className="w-px bg-border outline-white data-[separator=active]:bg-white data-[separator=active]:outline-1 data-[separator=hover]:bg-subtle z-90" />
        <Panel
          collapsible
          defaultSize="480px"
          minSize="400px"
          collapsedSize="60px"
          className="@container/aside"
          panelRef={asidePanelRef}
        >
          <aside className="h-full border-background border-l-(length:--seperator) flex-col hidden @sm/aside:flex">
            <header className="pb-(--seperator) flex flex-col gap-(--seperator) bg-black">
              <PlayerShipPanel />
              <Divider className="bg-accent" />
            </header>
            <div className="h-full border-l border-t flex-1 flex flex-col items-center justify-center overflow-hidden">
              <RHSPanelContainer />
            </div>
            <RHSPanelNav />
          </aside>
          <div className="h-full flex-col items-center justify-center hidden @max-sm/aside:flex">
            <Button
              variant="secondary"
              size="icon"
              className=""
              onClick={() => asidePanelRef?.current?.expand()}
            >
              <ArrowLeftIcon size={16} />
            </Button>
          </div>
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
