import { button, folder, useControls } from "leva"

import useGameStore from "@/stores/game"

import { MOCK_QUEST_LIST, MOCK_QUEST_STEP_COMPLETED } from "@/mocks/quest.mock"

export const useQuestControls = () => {
  const quests = useGameStore.use.quests()
  const setQuests = useGameStore.use.setQuests()
  const updateQuestStepCompleted = useGameStore.use.updateQuestStepCompleted()
  const completeQuest = useGameStore.use.completeQuest()
  const setQuestCompletionData = useGameStore.use.setQuestCompletionData()
  const setNotifications = useGameStore.use.setNotifications()

  return useControls(
    () => ({
      Quests: folder(
        {
          ["Load Mock"]: button(() => {
            setQuests(MOCK_QUEST_LIST)
          }),
          ["Step Complete"]: button(() => {
            const { quest_id, quest_name, step_name, step_index, next_step } =
              MOCK_QUEST_STEP_COMPLETED
            updateQuestStepCompleted(quest_id, step_index, next_step)
            if (next_step) {
              setQuestCompletionData({
                type: "step",
                questName: quest_name,
                completedStepName: step_name,
                nextStep: next_step,
              })
              setNotifications({ questCompleted: true })
            }
          }),
          ["Quest Complete"]: button(() => {
            const active = quests.find((q) => q.status === "active")
            if (!active) return
            setQuestCompletionData({
              type: "quest",
              completedQuestName: active.name,
              snapshotQuestIds: [],
            })
            completeQuest(active.quest_id)
            setNotifications({ questCompleted: true })
          }),
          ["Reset"]: button(() => {
            setQuests([])
          }),
        },
        { collapsed: true }
      ),
    }),
    [quests]
  )
}
