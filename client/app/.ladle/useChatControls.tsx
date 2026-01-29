import { button, folder, useControls } from "leva"
import { faker } from "@faker-js/faker"

import useGameStore from "@/stores/game"

import { INCOMING_CHAT_MESSAGES_MOCK } from "@/mocks/chat.mock"

export const useChatControls = () => {
  return useControls(() => ({
    Chat: folder(
      {
        ["Mock Incoming DM"]: button(() => {
          const state = useGameStore.getState()
          state.setNotifications({ newChatMessage: true })
          state.addMessage({
            ...INCOMING_CHAT_MESSAGES_MOCK[0],
            id: faker.number.int(),
            from_name: faker.person.fullName(),
            content: faker.lorem.paragraph(),
            timestamp: new Date().toISOString(),
          } as ChatMessage)
        }),
        ["Mock Incoming Broadcast"]: button(() => {
          const state = useGameStore.getState()
          state.setNotifications({ newChatMessage: true })
          state.addMessage({
            ...INCOMING_CHAT_MESSAGES_MOCK[0],
            id: faker.number.int(),
            from_name: faker.person.fullName(),
            content: faker.lorem.paragraph(),
            timestamp: new Date().toISOString(),
            type: "broadcast",
          } as ChatMessage)
        }),
      },
      { collapsed: true }
    ),
  }))
}
