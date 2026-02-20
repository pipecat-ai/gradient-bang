import type { QuestStepCompletedMessage } from "../types/messages"

export const MOCK_QUEST_LIST: Quest[] = [
  {
    code: "tutorial",
    meta: {},
    name: "Getting Started",
    status: "active",
    quest_id: "f8352a6e-05c3-4a9c-8429-f47c5372c6c5",
    started_at: "2026-02-20T12:50:26.37049+00:00",
    description: "Learn the basics of trading, navigation, and survival in the galaxy.",
    completed_at: null,
    current_step: {
      meta: {
        codec: {
          giver: "Federation Cadet Amy",
          pages: [
            "Welcome to the galaxy, pilot!",
            "Your first task is to travel to an adjacent sector. Use your ship's warp drive to move to a neighboring location. This will allow you to explore new areas and find opportunities for trading and adventure. Good luck!",
          ],
        },
      },
      name: "Travel to any adjacent sector",
      step_id: "c1e886dc-316d-4ae7-9d83-932f806eef13",
      quest_id: "f8352a6e-05c3-4a9c-8429-f47c5372c6c5",
      completed: false,
      step_index: 1,
      description: "Use the warp drive to move to a neighboring sector.",
      target_value: 1,
      current_value: 0,
    },
    completed_steps: [],
    current_step_index: 1,
  },
]

export const MOCK_QUEST_STEP_COMPLETED: QuestStepCompletedMessage = {
  step_id: "c1e886dc-316d-4ae7-9d83-932f806eef13",
  quest_id: "f8352a6e-05c3-4a9c-8429-f47c5372c6c5",
  next_step: {
    meta: {
      codec: {
        giver: "Federation Cadet Amy",
        pages: [
          "Great job on your first warp! Now, let's find the Megaport. The Megaport is a major hub for trade and commerce in the galaxy, and it's a great place to start your trading career. Keep warping to adjacent sectors until you find one that contains a Megaport. Once you arrive, you'll have access to markets, shipyards, and other facilities that will help you on your journey.",
        ],
      },
    },
    name: "Locate the Megaport",
    step_id: "7176a1ce-3a56-4cf1-802e-a88c6c94cfda",
    quest_id: "f8352a6e-05c3-4a9c-8429-f47c5372c6c5",
    completed: false,
    step_index: 2,
    description: "Find a sector that contains a Megaport.",
    target_value: 1,
    current_value: 0,
  },
  step_name: "Travel to any adjacent sector",
  quest_code: "tutorial",
  quest_name: "Getting Started",
  step_index: 1,
}
