import { RHSPanelContent } from "@/components/panels/RHSPanelContainer"
import { TaskOutputStream } from "@/components/TaskOutputStream"
import useGameStore from "@/stores/game"

export const TaskStreamPanel = () => {
  const activePanelData = useGameStore.use.activePanelData?.()
  const taskId = activePanelData as string | undefined

  if (!taskId) {
    return null
  }

  return (
    <RHSPanelContent noScroll className="bg-background/30">
      <TaskOutputStream taskId={taskId} className="px-ui-sm pb-ui-sm" />
    </RHSPanelContent>
  )
}
