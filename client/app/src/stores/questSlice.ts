import { produce } from "immer"
import type { StateCreator } from "zustand"

export type QuestCompletionData =
  | {
      type: "step"
      questName: string
      completedStepName: string
      nextStep: QuestStep
    }
  | {
      type: "quest"
      completedQuestName: string
      snapshotQuestIds: string[]
    }

export interface QuestSlice {
  quests: Quest[]
  setQuests: (quests: Quest[]) => void
  updateQuestStepCompleted: (questId: string, stepIndex: number, nextStep?: QuestStep) => void
  completeQuest: (questId: string) => void
  getActiveQuests: () => Quest[]
  getQuestByCode: (code: string) => Quest | undefined
  questCompletionData: QuestCompletionData | null
  setQuestCompletionData: (data: QuestCompletionData) => void
}

export const createQuestSlice: StateCreator<QuestSlice> = (set, get) => ({
  quests: [],

  setQuests: (quests: Quest[]) => set({ quests }),

  updateQuestStepCompleted: (questId: string, stepIndex: number, nextStep?: QuestStep) =>
    set(
      produce((state) => {
        const quest = state.quests.find((q: Quest) => q.quest_id === questId)
        if (!quest) return

        if (quest.current_step && quest.current_step.step_index === stepIndex) {
          quest.completed_steps.push({
            ...quest.current_step,
            completed: true,
            current_value: quest.current_step.target_value,
          })
          quest.current_step_index = stepIndex + 1
          quest.current_step = nextStep ?? null
        }
      })
    ),

  completeQuest: (questId: string) =>
    set(
      produce((state) => {
        const quest = state.quests.find((q: Quest) => q.quest_id === questId)
        if (!quest) return

        quest.status = "completed"
        quest.completed_at = new Date().toISOString()

        if (quest.current_step) {
          quest.completed_steps.push({
            ...quest.current_step,
            completed: true,
            current_value: quest.current_step.target_value,
          })
          quest.current_step = null
        }
      })
    ),

  getActiveQuests: () => get().quests.filter((q) => q.status === "active"),

  getQuestByCode: (code: string) => get().quests.find((q) => q.code === code),

  questCompletionData: null,

  setQuestCompletionData: (data: QuestCompletionData) =>
    set(
      produce((state) => {
        if (data.type === "quest") {
          state.questCompletionData = {
            ...data,
            snapshotQuestIds: state.quests.map((q: Quest) => q.quest_id),
          }
        } else {
          state.questCompletionData = data
        }
      })
    ),
})
