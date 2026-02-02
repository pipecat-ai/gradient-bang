import type { StateCreator } from "zustand"

const MAX_CHAT_MESSAGES = 500

// Turn completion markers from pipecat - strip from display
const TURN_MARKER_REGEX = /[✓○◐]/g

const stripTurnMarkers = (text: string): string => {
  return text.replace(TURN_MARKER_REGEX, "")
}

export interface ChatSlice {
  chatMessages: ConversationMessage[]
  chatCallbacks: Map<string, (message: ConversationMessage) => void>
  // Store separate text streams for LLM and TTS
  llmTextStreams: Map<string, string> // messageId -> accumulated LLM text
  ttsTextStreams: Map<string, string> // messageId -> accumulated TTS text
  // Track last chunk added to detect duplicates (React Strict Mode double-handler issue)
  lastLlmChunk: Map<string, string> // messageId -> last chunk text
  lastTtsChunk: Map<string, string> // messageId -> last chunk text
  // Track if bot has started speaking this exchange (reset when user speaks)
  botHasSpoken: boolean

  // Actions
  registerChatCallback: (
    id: string,
    callback?: (message: ConversationMessage) => void
  ) => void
  unregisterChatCallback: (id: string) => void
  clearChatMessages: () => void
  addChatMessage: (
    message: Omit<ConversationMessage, "createdAt" | "updatedAt">
  ) => void
  updateLastMessage: (
    role: "user" | "assistant",
    updates: Partial<ConversationMessage>
  ) => void
  finalizeLastMessage: (role: "user" | "assistant") => void
  removeEmptyLastMessage: (role: "user" | "assistant") => void
  injectMessage: (message: {
    role: "user" | "assistant" | "system"
    parts: ConversationMessagePart[]
  }) => void
  upsertUserTranscript: (text: string | React.ReactNode, final: boolean) => void
  updateAssistantText: (
    text: string,
    final: boolean,
    source: "llm" | "tts"
  ) => void
  startAssistantLlmStream: () => void
  addToolCallMessage: (functionName: string) => void
  setBotHasSpoken: (value: boolean) => void
  removeTentativeToolMessages: () => void
}

export const sortByCreatedAt = (
  a: ConversationMessage,
  b: ConversationMessage
): number => {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

export const isMessageEmpty = (message: ConversationMessage): boolean => {
  const parts = message.parts || []
  if (parts.length === 0) return true
  return parts.every((p) =>
    typeof p.text === "string" ? p.text.trim().length === 0 : false
  )
}

export const filterEmptyMessages = (
  messages: ConversationMessage[]
): ConversationMessage[] => {
  return messages.filter((message, index, array) => {
    if (!isMessageEmpty(message)) return true

    // For empty messages, keep only if no following non-empty message with same role
    const nextMessageWithSameRole = array
      .slice(index + 1)
      .find((m) => m.role === message.role && !isMessageEmpty(m))

    return !nextMessageWithSameRole
  })
}

export const mergeMessages = (
  messages: ConversationMessage[]
): ConversationMessage[] => {
  const mergedMessages: ConversationMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const currentMessage = messages[i]
    const lastMerged = mergedMessages[mergedMessages.length - 1]

    const timeDiff = lastMerged
      ? Math.abs(
          new Date(currentMessage.createdAt).getTime() -
            new Date(lastMerged.createdAt).getTime()
        )
      : Infinity

    const shouldMerge =
      lastMerged &&
      lastMerged.role === currentMessage.role &&
      currentMessage.role !== "system" &&
      currentMessage.role !== "tool" &&
      timeDiff < 30000

    if (shouldMerge) {
      mergedMessages[mergedMessages.length - 1] = {
        ...lastMerged,
        parts: [...(lastMerged.parts || []), ...(currentMessage.parts || [])],
        updatedAt: currentMessage.updatedAt || currentMessage.createdAt,
        final: currentMessage.final !== false,
      }
    } else {
      mergedMessages.push({ ...currentMessage })
    }
  }

  return mergedMessages
}

// Helper function to prune messages to keep only the most recent
const pruneMessages = (
  messages: ConversationMessage[]
): ConversationMessage[] => {
  if (messages.length <= MAX_CHAT_MESSAGES) return messages
  return messages.slice(-MAX_CHAT_MESSAGES)
}

// Helper function to call all registered callbacks
const callAllMessageCallbacks = (
  callbacks: Map<string, (message: ConversationMessage) => void>,
  message: ConversationMessage
) => {
  callbacks.forEach((callback) => {
    try {
      callback(message)
    } catch (error) {
      console.error("Error in message callback:", error)
    }
  })
}

export const createChatSlice: StateCreator<ChatSlice> = (set) => ({
  chatMessages: [],
  chatCallbacks: new Map(),
  llmTextStreams: new Map(),
  ttsTextStreams: new Map(),
  lastLlmChunk: new Map(),
  lastTtsChunk: new Map(),
  botHasSpoken: false,

  registerChatCallback: (id, callback) =>
    set((state) => {
      const newState = { ...state }
      newState.chatCallbacks.set(id, callback || (() => {}))
      return newState
    }),

  unregisterChatCallback: (id) =>
    set((state) => {
      const newState = { ...state }
      newState.chatCallbacks.delete(id)
      return newState
    }),

  clearChatMessages: () =>
    set({
      chatMessages: [],
      llmTextStreams: new Map(),
      ttsTextStreams: new Map(),
      lastLlmChunk: new Map(),
      lastTtsChunk: new Map(),
      botHasSpoken: false,
    }),

  addChatMessage: (messageData) => {
    const now = new Date()
    const message: ConversationMessage = {
      ...messageData,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }

    set((state) => {
      const updatedMessages = [...state.chatMessages, message]
      const processedMessages = pruneMessages(
        mergeMessages(
          filterEmptyMessages(updatedMessages.sort(sortByCreatedAt))
        )
      )

      callAllMessageCallbacks(state.chatCallbacks, message)
      return { chatMessages: processedMessages }
    })
  },

  updateLastMessage: (role, updates) => {
    set((state) => {
      const messages = [...state.chatMessages]
      const lastMessageIndex = messages.findLastIndex(
        (msg) => msg.role === role
      )

      if (lastMessageIndex === -1) return state

      const updatedMessage = {
        ...messages[lastMessageIndex],
        ...updates,
        updatedAt: new Date().toISOString(),
      } as ConversationMessage

      messages[lastMessageIndex] = updatedMessage
      const processedMessages = pruneMessages(
        mergeMessages(filterEmptyMessages(messages.sort(sortByCreatedAt)))
      )

      callAllMessageCallbacks(state.chatCallbacks, updatedMessage)
      return { chatMessages: processedMessages }
    })
  },

  finalizeLastMessage: (role) => {
    set((state) => {
      const messages = [...state.chatMessages]
      const lastMessageIndex = messages.findLastIndex(
        (msg) => msg.role === role
      )

      if (lastMessageIndex === -1) return state

      const lastMessage = messages[lastMessageIndex]

      // Check if message is empty in both parts and text streams
      const hasTextInStreams =
        state.llmTextStreams.get(lastMessage.createdAt) ||
        state.ttsTextStreams.get(lastMessage.createdAt)

      if (isMessageEmpty(lastMessage) && !hasTextInStreams) {
        // Remove empty message only if it has no text in streams either
        messages.splice(lastMessageIndex, 1)
      } else {
        // Finalize message and its last part
        const parts = [...(lastMessage.parts || [])]
        if (parts.length > 0) {
          parts[parts.length - 1] = {
            ...parts[parts.length - 1],
            final: true,
          }
        }
        messages[lastMessageIndex] = {
          ...lastMessage,
          parts,
          final: true,
          updatedAt: new Date().toISOString(),
        }
        callAllMessageCallbacks(state.chatCallbacks, messages[lastMessageIndex])
      }

      const processedMessages = pruneMessages(
        mergeMessages(filterEmptyMessages(messages.sort(sortByCreatedAt)))
      )

      return { chatMessages: processedMessages }
    })
  },

  removeEmptyLastMessage: (role) => {
    set((state) => {
      const messages = [...state.chatMessages]
      const lastMessageIndex = messages.findLastIndex(
        (msg) => msg.role === role
      )

      if (lastMessageIndex === -1) return state

      const lastMessage = messages[lastMessageIndex]
      if (isMessageEmpty(lastMessage)) {
        messages.splice(lastMessageIndex, 1)
        const processedMessages = pruneMessages(
          mergeMessages(filterEmptyMessages(messages.sort(sortByCreatedAt)))
        )
        return { chatMessages: processedMessages }
      }

      return state
    })
  },

  injectMessage: (messageData) => {
    const now = new Date()
    const message: ConversationMessage = {
      role: messageData.role,
      final: true,
      parts: [...messageData.parts],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }

    set((state) => {
      const updatedMessages = [...state.chatMessages, message]
      const processedMessages = pruneMessages(
        mergeMessages(
          filterEmptyMessages(updatedMessages.sort(sortByCreatedAt))
        )
      )

      callAllMessageCallbacks(state.chatCallbacks, message)
      return { chatMessages: processedMessages }
    })
  },

  upsertUserTranscript: (text, final) => {
    const now = new Date()
    set((state) => {
      let messages = [...state.chatMessages]

      // If bot hasn't spoken yet, we might need to remove tentative tool messages
      // and continue the user's turn
      if (!state.botHasSpoken) {
        // Remove any tentative tool messages (user is continuing their turn)
        messages = messages.filter((m) => m.role !== "tool")
      }

      // Find last user message
      const lastUserIndex = messages.findLastIndex((m) => m.role === "user")
      const lastUserMessage =
        lastUserIndex !== -1 ? messages[lastUserIndex] : undefined

      // KEY FIX: Only update existing user message if it's NOT final
      // If bot hasn't spoken AND there's a non-final user message, continue that turn
      if (!state.botHasSpoken && lastUserMessage && !lastUserMessage.final) {
        // Update existing non-final user message
        const target = { ...lastUserMessage }
        const parts: ConversationMessagePart[] = Array.isArray(target.parts)
          ? [...target.parts]
          : []

        const lastPart = parts[parts.length - 1]
        if (!lastPart || lastPart.final) {
          // Start a new part
          parts.push({ text, final, createdAt: now.toISOString() })
        } else {
          // Update in-progress part
          parts[parts.length - 1] = {
            ...lastPart,
            text,
            final,
          }
        }

        const updatedMessage: ConversationMessage = {
          ...target,
          // Don't finalize based on transcript final flag - wait for BotTtsStarted
          final: false,
          parts,
          updatedAt: now.toISOString(),
        }

        messages[lastUserIndex] = updatedMessage

        const processedMessages = pruneMessages(
          mergeMessages(filterEmptyMessages(messages.sort(sortByCreatedAt)))
        )

        callAllMessageCallbacks(state.chatCallbacks, updatedMessage)
        return { chatMessages: processedMessages }
      }

      // Bot has spoken OR user message is final - check if we can update existing non-final
      if (lastUserIndex !== -1 && !messages[lastUserIndex].final) {
        // Update existing non-final user message
        const target = { ...messages[lastUserIndex] }
        const parts: ConversationMessagePart[] = Array.isArray(target.parts)
          ? [...target.parts]
          : []

        const lastPart = parts[parts.length - 1]
        if (!lastPart || lastPart.final) {
          parts.push({ text, final, createdAt: now.toISOString() })
        } else {
          parts[parts.length - 1] = {
            ...lastPart,
            text,
            final,
          }
        }

        const updatedMessage: ConversationMessage = {
          ...target,
          final: final ? true : target.final,
          parts,
          updatedAt: now.toISOString(),
        }

        messages[lastUserIndex] = updatedMessage

        const processedMessages = pruneMessages(
          mergeMessages(filterEmptyMessages(messages.sort(sortByCreatedAt)))
        )

        callAllMessageCallbacks(state.chatCallbacks, updatedMessage)
        return { chatMessages: processedMessages }
      }

      // Create a new user message initialized with this transcript
      const newMessage: ConversationMessage = {
        role: "user",
        final,
        parts: [
          {
            text,
            final,
            createdAt: now.toISOString(),
          },
        ],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }

      const updatedMessages = [...messages, newMessage]
      const processedMessages = pruneMessages(
        mergeMessages(
          filterEmptyMessages(updatedMessages.sort(sortByCreatedAt))
        )
      )
      callAllMessageCallbacks(state.chatCallbacks, newMessage)
      return { chatMessages: processedMessages }
    })
  },

  updateAssistantText: (text, final, source) => {
    const now = new Date()
    const filteredText = stripTurnMarkers(text)

    // Skip if filtering removed all content
    if (!filteredText) return

    set((state) => {
      const messages = [...state.chatMessages]
      const llmTextStreams = new Map(state.llmTextStreams)
      const ttsTextStreams = new Map(state.ttsTextStreams)
      const lastLlmChunk = new Map(state.lastLlmChunk)
      const lastTtsChunk = new Map(state.lastTtsChunk)

      const lastAssistantIndex = messages.findLastIndex(
        (msg) => msg.role === "assistant"
      )

      let messageId: string

      if (lastAssistantIndex === -1) {
        // Create new assistant message
        messageId = now.toISOString()
        const newMessage: ConversationMessage = {
          role: "assistant",
          final,
          parts: [],
          createdAt: messageId,
          updatedAt: messageId,
        }
        messages.push(newMessage)
      } else {
        // Update existing assistant message
        const lastMessage = messages[lastAssistantIndex]
        messageId = lastMessage.createdAt

        messages[lastAssistantIndex] = {
          ...lastMessage,
          final: final ? true : lastMessage.final,
          updatedAt: now.toISOString(),
        }
      }

      // DEDUPLICATION: Check if this chunk is a duplicate
      // React Strict Mode causes double event handler registration
      const lastChunkMap = source === "llm" ? lastLlmChunk : lastTtsChunk
      const lastChunk = lastChunkMap.get(messageId)
      if (lastChunk === filteredText) {
        // Duplicate chunk - skip update
        return state
      }
      lastChunkMap.set(messageId, filteredText)

      // Update the appropriate text stream
      if (source === "llm") {
        const currentText = llmTextStreams.get(messageId) || ""
        llmTextStreams.set(messageId, currentText + filteredText)
      } else {
        const currentText = ttsTextStreams.get(messageId) || ""
        // Add space between TTS chunks for proper word separation
        const separator =
          currentText && !currentText.endsWith(" ") && !filteredText.startsWith(" ")
            ? " "
            : ""
        ttsTextStreams.set(messageId, currentText + separator + filteredText)
      }

      // Don't filter out messages that have text in the text streams
      const processedMessages = pruneMessages(
        mergeMessages(messages.sort(sortByCreatedAt))
      )

      return {
        chatMessages: processedMessages,
        llmTextStreams,
        ttsTextStreams,
        lastLlmChunk,
        lastTtsChunk,
      }
    })
  },

  startAssistantLlmStream: () => {
    set((state) => {
      const messages = [...state.chatMessages]
      const llmTextStreams = new Map(state.llmTextStreams)
      const now = new Date()

      // Get the last assistant message
      const lastAssistantIndex = messages.findLastIndex(
        (msg) => msg.role === "assistant"
      )
      const lastAssistant =
        lastAssistantIndex !== -1 ? messages[lastAssistantIndex] : undefined

      // KEY FIX: Check finality, not position
      // Create new assistant message if there's none OR if the last one is FINAL
      if (!lastAssistant || lastAssistant.final) {
        // Create a new assistant message
        const newMessage: ConversationMessage = {
          role: "assistant",
          final: false,
          parts: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
        messages.push(newMessage)
      } else {
        // Last assistant message is non-final - reset its stream for new LLM turn
        const messageId = lastAssistant.createdAt

        // Reset the stream for new LLM turn instead of appending
        // BotLlmStarted indicates a fresh LLM generation
        llmTextStreams.set(messageId, "")

        messages[lastAssistantIndex] = {
          ...lastAssistant,
          final: false,
          updatedAt: now.toISOString(),
        }
      }

      const processedMessages = pruneMessages(
        mergeMessages(filterEmptyMessages(messages.sort(sortByCreatedAt)))
      )

      return {
        chatMessages: processedMessages,
        llmTextStreams,
      }
    })
  },

  addToolCallMessage: (functionName) => {
    set((state) => {
      // DEDUPLICATION: Check if last message is already a tool message with same name
      // React Strict Mode causes double event handler registration
      const lastMessage = state.chatMessages[state.chatMessages.length - 1]
      if (
        lastMessage?.role === "tool" &&
        lastMessage.parts?.[0]?.text === functionName
      ) {
        // Duplicate tool call - skip
        return state
      }

      const now = new Date()
      const message: ConversationMessage = {
        role: "tool",
        final: true,
        parts: [{ text: functionName, final: true, createdAt: now.toISOString() }],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }
      const updatedMessages = [...state.chatMessages, message]
      const processedMessages = pruneMessages(updatedMessages.sort(sortByCreatedAt))
      callAllMessageCallbacks(state.chatCallbacks, message)
      return { chatMessages: processedMessages }
    })
  },

  setBotHasSpoken: (value) => set({ botHasSpoken: value }),

  removeTentativeToolMessages: () => {
    set((state) => {
      const messages = state.chatMessages.filter((m) => m.role !== "tool")
      const processedMessages = pruneMessages(
        mergeMessages(filterEmptyMessages(messages.sort(sortByCreatedAt)))
      )
      return { chatMessages: processedMessages }
    })
  },
})
