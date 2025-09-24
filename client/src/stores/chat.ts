import { create } from "zustand";

export interface ChatMessage {
  id: string;
  timestamp: string;
  type: string;
  from_name?: string;
  to_name?: string;
  content: string;
}

interface ChatState {
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  clear: () => void;
}

const MAX_MESSAGES = 200;

const useChatStore = create<ChatState>((set) => ({
  messages: [],
  addMessage: (message) =>
    set((state) => {
      if (state.messages.some((existing) => existing.id === message.id)) {
        return state;
      }
      const next = [...state.messages, message];
      if (next.length > MAX_MESSAGES) {
        next.splice(0, next.length - MAX_MESSAGES);
      }
      return { messages: next };
    }),
  clear: () => set({ messages: [] }),
}));

export default useChatStore;
