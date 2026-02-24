import type { QuestStepCompletedMessage } from "../types/messages"

const TUTORIAL_QUEST_ID = "f8352a6e-05c3-4a9c-8429-f47c5372c6c5"
const TUTORIAL_CORPS_QUEST_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

export const MOCK_QUEST_STEPS: QuestStep[] = [
  {
    meta: {
      codec: {
        giver_id: "cadet_amy",
        giver: "Amy, Federation Cadet",
        pages: [
          '<emotion value="excitable">Welcome to the galaxy, pilot! <emotion value="content" />I\'m Amy, a representative from the Federation, and I\'ll be guiding you through your first steps as a spacefaring trader.',
          '<emotion value="neutral" /> In this tutorial, we\'ll cover the basics of navigation, trading, and survival in the galaxy. Don\'t worry, it\'s easier than it sounds! Let\'s get started.',
          '<emotion value="anticipation">Your first task is to travel to an adjacent sector.</emotion> Use your ship\'s warp drive to move to a neighboring location. This will allow you to explore new areas and find opportunities for trading and adventure. Good luck!',
        ],
      },
    },
    name: "Travel to any adjacent sector",
    step_id: "c1e886dc-316d-4ae7-9d83-932f806eef13",
    quest_id: TUTORIAL_QUEST_ID,
    completed: false,
    step_index: 1,
    description: "Use the warp drive to move to a neighboring sector.",
    target_value: 1,
    current_value: 0,
  },
  {
    meta: {
      codec: {
        giver_id: "cadet_amy",
        giver: "Amy, Federation Cadet",
        pages: [
          "Great job on your first warp! Now, let's find the Megaport. The Megaport is a major hub for trade and commerce in the galaxy, and it's a great place to start your trading career. Keep warping to adjacent sectors until you find one that contains a Megaport. Once you arrive, you'll have access to markets, shipyards, and other facilities that will help you on your journey.",
        ],
      },
    },
    name: "Locate the Megaport",
    step_id: "7176a1ce-3a56-4cf1-802e-a88c6c94cfda",
    quest_id: TUTORIAL_QUEST_ID,
    completed: false,
    step_index: 2,
    description: "Find a sector that contains a Megaport.",
    target_value: 1,
    current_value: 0,
  },
  {
    meta: {
      codec: {
        giver_id: "cadet_amy",
        giver: "Amy, Federation Cadet",
        pages: [
          "Now that you've found the Megaport, it's time to refuel your ship. Purchase warp fuel to recharge your drives and continue your journey through the galaxy.",
        ],
      },
    },
    name: "Refuel your ship",
    step_id: "a3b4c5d6-e7f8-9012-3456-789012345678",
    quest_id: TUTORIAL_QUEST_ID,
    completed: false,
    step_index: 3,
    description: "Purchase warp fuel to recharge your drives.",
    target_value: 1,
    current_value: 0,
  },
  {
    meta: {},
    name: "Purchase a commodity",
    step_id: "b4c5d6e7-f890-1234-5678-901234567890",
    quest_id: TUTORIAL_QUEST_ID,
    completed: false,
    step_index: 4,
    description: "Buy goods from a port to begin trading.",
    target_value: 1,
    current_value: 0,
  },
  {
    meta: {
      codec: {
        giver_id: "cadet_amy",
        giver: "Amy, Federation Cadet",
        pages: [
          "<emotion value=\"content\">Great, you've made your first trade!</emotion> Now here's the thing — that Sparrow you're flying is a loaner from the Federation. It's fine for getting started, but you're going to want your own ship.",
          "<emotion value=\"anticipation\">Our goal is to upgrade you to a Kestrel Courier.</emotion> It's fast, reliable, and it's yours to keep. To get there, you'll need to earn some credits. Keep trading between ports — buy low, sell high — and you'll have enough in no time.",
        ],
      },
    },
    name: "Earn 1000 credits trading",
    step_id: "c5d6e7f8-9012-3456-7890-123456789012",
    quest_id: TUTORIAL_QUEST_ID,
    completed: false,
    step_index: 5,
    description: "Generate at least 1000 credits in trading profit.",
    target_value: 1000,
    current_value: 0,
  },
  {
    meta: {},
    name: "Purchase a kestrel",
    step_id: "d6e7f890-1234-5678-9012-345678901234",
    quest_id: TUTORIAL_QUEST_ID,
    completed: false,
    step_index: 6,
    description: "Buy a Kestrel Courier from a shipyard.",
    target_value: 1,
    current_value: 0,
  },
  {
    meta: {
      codec: {
        giver_id: "cadet_amy",
        giver: "Amy, Federation Cadet",
        pages: [
          "<emotion value=\"impressed\">Nice work on the Kestrel, pilot!</emotion> You're really getting the hang of this. Now it's time to take on something bigger.",
          '<emotion value="neutral" />The Federation contracts board has new assignments available. You\'ll find it at the Megaport. Commander Voss has posted a contract about forming corporations and managing fleets. <emotion value="encouraging">Head to the contracts board and accept his contract to continue your training.</emotion>',
        ],
      },
    },
    name: "Accept a contract from the contracts board",
    step_id: "e7f89012-3456-7890-1234-567890123456",
    quest_id: TUTORIAL_QUEST_ID,
    completed: false,
    step_index: 7,
    description: "Visit the contracts board and accept a new contract from Commander Voss.",
    target_value: 1,
    current_value: 0,
  },
]

export const MOCK_TUTORIAL_CORPS_STEPS: QuestStep[] = [
  {
    meta: {
      codec: {
        giver_id: "commander_voss",
        giver: "Voss, Commander",
        pages: [
          "Now that you've got a handle on trading and navigation, it's time to think bigger. Corporations are the backbone of power in this galaxy.",
          "You can either create your own corporation or join an existing one. Either way, you'll gain access to shared resources, fleet ships, and the ability to coordinate with other players.",
        ],
      },
    },
    name: "Create or join a corporation",
    step_id: "f8901234-5678-9012-3456-789012345678",
    quest_id: TUTORIAL_CORPS_QUEST_ID,
    completed: false,
    step_index: 1,
    description: "Form a new corporation or join an existing one.",
    target_value: 1,
    current_value: 0,
  },
  {
    meta: {
      codec: {
        giver_id: "commander_voss",
        giver: "Voss, Commander",
        pages: [
          "Excellent! Now that you're part of a corporation, you can command fleet ships. Corporation ships operate independently from your personal vessel, allowing you to run tasks across multiple sectors simultaneously.",
          "Purchase a corporation ship from any shipyard, then assign it a task. This is the key to scaling your operations and building real wealth in the galaxy.",
        ],
      },
    },
    name: "Run a task on a corp ship",
    step_id: "09123456-7890-1234-5678-901234567890",
    quest_id: TUTORIAL_CORPS_QUEST_ID,
    completed: false,
    step_index: 2,
    description: "Purchase or select a corporation ship and execute a task on it.",
    target_value: 1,
    current_value: 0,
  },
]

export const MOCK_QUEST_LIST: Quest[] = [
  {
    code: "tutorial",
    meta: { giver: "Federation Intake Program" },
    name: "Taking Flight",
    status: "active",
    quest_id: TUTORIAL_QUEST_ID,
    started_at: "2026-02-20T12:50:26.37049+00:00",
    description: "Learn the basics of trading, navigation, and survival in the galaxy.",
    completed_at: null,
    current_step: MOCK_QUEST_STEPS[0],
    completed_steps: [],
    current_step_index: 1,
  },
]

export const MOCK_TUTORIAL_CORPS_QUEST: Quest = {
  code: "tutorial_corporations",
  meta: {},
  name: "Corporations & Fleet Command",
  status: "active",
  quest_id: TUTORIAL_CORPS_QUEST_ID,
  started_at: "2026-02-22T10:00:00.000000+00:00",
  description: "Learn how to form a corporation and manage a fleet of ships.",
  completed_at: null,
  current_step: MOCK_TUTORIAL_CORPS_STEPS[0],
  completed_steps: [],
  current_step_index: 1,
}

export const MOCK_QUEST_STEP_COMPLETED: QuestStepCompletedMessage = {
  step_id: "c1e886dc-316d-4ae7-9d83-932f806eef13",
  quest_id: TUTORIAL_QUEST_ID,
  next_step: MOCK_QUEST_STEPS[1],
  step_name: "Travel to any adjacent sector",
  quest_code: "tutorial",
  quest_name: "Taking Flight",
  step_index: 1,
}
