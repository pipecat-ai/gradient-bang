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
  updateQuestStepProgress: (questId: string, stepIndex: number, currentValue: number) => void
  updateQuestStepCompleted: (questId: string, stepIndex: number, nextStep?: QuestStep) => void
  completeQuest: (questId: string) => void
  getActiveQuests: () => Quest[]
  getQuestByCode: (code: string) => Quest | undefined
  getActiveCodec: (questId?: string) => QuestCodec | null
  viewCodec: QuestCodec | null
  setViewCodec: (codec: QuestCodec | null) => void
  questCompletionData: QuestCompletionData | null
  setQuestCompletionData: (data: QuestCompletionData) => void
}

export const createQuestSlice: StateCreator<QuestSlice> = (set, get) => ({
  quests: [],

  setQuests: (quests: Quest[]) =>
    set(
      produce((state) => {
        state.quests = quests
        const codecQuest = quests.find(
          (q: Quest) => q.status === "active" && q.current_step?.meta?.codec
        )
        if (codecQuest) {
          ;(state as Record<string, any>).notifications.incomingCodec = codecQuest.quest_id
        }
      })
    ),

  updateQuestStepProgress: (questId: string, stepIndex: number, currentValue: number) =>
    set(
      produce((state) => {
        const quest = state.quests.find((q: Quest) => q.quest_id === questId)
        if (!quest || !quest.current_step) return
        if (quest.current_step.step_index === stepIndex) {
          quest.current_step.current_value = currentValue
        }
      })
    ),

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

        if (nextStep?.meta?.codec) {
          ;(state as Record<string, any>).notifications.incomingCodec = questId
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

  getActiveCodec: (questId?: string) => {
    if (questId) {
      const quest = get().quests.find((q) => q.quest_id === questId)
      return quest?.current_step?.meta?.codec ?? null
    }
    const activeQuests = get().quests.filter((q) => q.status === "active")
    for (const quest of activeQuests) {
      if (quest.current_step?.meta?.codec) {
        return quest.current_step.meta.codec
      }
    }
    return null
  },

  viewCodec: null,

  setViewCodec: (codec: QuestCodec | null) =>
    set(
      produce((state) => {
        state.viewCodec = codec
      })
    ),

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
