import type { QuestStepCompletedMessage } from "../types/messages"

export const MOCK_QUEST_LIST: Quest[] = [
  {
    code: "tutorial",
    meta: {},
    name: "Getting Started",
    status: "active",
    quest_id: "2ab28cdc-73a7-4850-a5d7-9bd43e0efdee",
    started_at: "2026-02-20T12:08:38.530485+00:00",
    description: "Learn the basics of trading, navigation, and survival in the galaxy.",
    completed_at: null,
    current_step: {
      quest_id: "2ab28cdc-73a7-4850-a5d7-9bd43e0efdee",
      step_id: "86b612fd-0310-48d3-b6ce-a16bd9c8dc88",
      step_index: 1,
      name: "Travel to any adjacent sector",
      description: "Use the warp drive to move to a neighboring sector.",
      target_value: 1,
      current_value: 0,
      completed: false,
      meta: {},
    },
    completed_steps: [],
    current_step_index: 1,
  },
]

export const MOCK_QUEST_STEP_COMPLETED: QuestStepCompletedMessage = {
  quest_id: "2ab28cdc-73a7-4850-a5d7-9bd43e0efdee",
  quest_code: "tutorial",
  quest_name: "Getting Started",
  step_id: "86b612fd-0310-48d3-b6ce-a16bd9c8dc88",
  step_name: "Travel to any adjacent sector",
  step_index: 1,
  next_step: {
    quest_id: "2ab28cdc-73a7-4850-a5d7-9bd43e0efdee",
    step_id: "a1b2c3d4-0000-0000-0000-000000000002",
    step_index: 2,
    name: "Locate the Megaport",
    description: "Find a sector that contains a Megaport.",
    target_value: 1,
    current_value: 0,
    completed: false,
    meta: {},
  },
}
