import { ConversationPanel } from "@/components/conversation/ConversationPanel"
import { MobileMap } from "@/components/mobile/Map"
import { TopBar } from "@/components/mobile/TopBar"
import { PipecatClientAudio } from "@/components/PipecatClientAudio"
import { Divider } from "@/components/primitives/Divider"

export const Mobile = () => {
  return (
    <>
      <div className="h-svh w-svw overflow-hidden flex flex-col">
        <TopBar />
        <main className="flex flex-col px-ui-xs flex-1 gap-ui-xs pb-ui-xs">
          <MobileMap />
          <Divider variant="dashed" className="h-2 text-foreground/30" />
          <ConversationPanel />
        </main>
      </div>
      <PipecatClientAudio />
    </>
  )
}
