import type { Story } from "@ladle/react"

import { MovementHistoryPanel } from "@/components/panels/DataTablePanels"
import { PlayerShipFuelBadge } from "@/components/PlayerShipBadges"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/primitives/Tabs"
import useGameStore from "@/stores/game"

export const DataTableStory: Story = () => {
  const movementHistory = useGameStore((state) => state.movement_history)

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar */}
      <header className="shrink-0 border-b px-4 py-3">
        <div className="text-sm font-medium text-foreground">Movement History</div>
      </header>

      {/* Content row */}
      <div className="flex-1 flex min-h-0">
        {/* Main */}
        <main className="flex-1 p-3 flex">
          {/* Panel */}
          <div className="flex-1 flex flex-col bg-background">
            {/* DataTable */}
            <MovementHistoryPanel />
            {/* Panel footer */}
            <div className="shrink-0 border-t px-4 py-3 text-xs text-muted-foreground text-center">
              {movementHistory.length} records
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

DataTableStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}

export const TabsStory: Story = () => {
  return (
    <div className="bg-background p-4">
      <Tabs defaultValue="overview" className="w-[400px]">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="help">Help</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview</TabsContent>
        <TabsContent value="settings">Settings</TabsContent>
        <TabsContent value="help">Help</TabsContent>
      </Tabs>

      <Tabs defaultValue="overview" className="w-[400px]" orientation="vertical">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="help">Help</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview</TabsContent>
        <TabsContent value="settings">Settings</TabsContent>
        <TabsContent value="help">Help</TabsContent>
      </Tabs>
    </div>
  )
}
TabsStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}

export const ProgressIndicatorStory: Story = () => {
  return (
    <div className="w-[400px]">
      <PlayerShipFuelBadge className="w-full" />
    </div>
  )
}
ProgressIndicatorStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}
