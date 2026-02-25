import { useMemo, useRef } from "react"

import { RTVIEvent } from "@pipecat-ai/client-js"
import { useRTVIClientEvent } from "@pipecat-ai/client-react"

import { filterEmptyMessages, mergeMessages, sortByCreatedAt } from "@/stores/chatSlice"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

export type TextMode = "llm" | "tts"

interface Props {
  onMessageAdded?: (message: ConversationMessage) => void
  textMode?: TextMode
}

export const useChat = ({ textMode = "llm" }: Props = {}) => {
  const userStoppedTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  const assistantStreamResetRef = useRef<number>(0)
  const hasReceivedInitialUserUnmute = useRef(false)

  // Get the raw state from the store using separate selectors
  const messages = useGameStore.use.chatMessages()
  const llmTextStreams = useGameStore.use.llmTextStreams()
  const ttsTextStreams = useGameStore.use.ttsTextStreams()
  const clearMessages = useGameStore.use.clearChatMessages()
  const startAssistantLlmStream = useGameStore.use.startAssistantLlmStream()
  const updateAssistantText = useGameStore.use.updateAssistantText()
  const finalizeLastMessage = useGameStore.use.finalizeLastMessage()
  const removeEmptyLastMessage = useGameStore.use.removeEmptyLastMessage()
  const addChatMessage = useGameStore.use.addChatMessage()
  const upsertUserTranscript = useGameStore.use.upsertUserTranscript()
  const setBotHasSpoken = useGameStore.use.setBotHasSpoken()
  const addToolCallMessage = useGameStore.use.addToolCallMessage()
  const addToolCallResultMessage = useGameStore.use.addToolCallResultMessage()
  const playSound = useAudioStore.use.playSound()

  useRTVIClientEvent(RTVIEvent.Connected, () => {
    hasReceivedInitialUserUnmute.current = false
    clearMessages()
  })

  useRTVIClientEvent(RTVIEvent.UserMuteStopped, () => {
    hasReceivedInitialUserUnmute.current = true
    playSound("chime7", { volume: 0.2 })
  })

  useRTVIClientEvent(RTVIEvent.ServerMessage, (data) => {
    if (data?.event === "llm.function_call" && data?.payload?.name) {
      addToolCallMessage(data.payload.name, data.payload.args)
    }
    if (data?.event === "llm.function_call_result" && data?.payload?.name) {
      addToolCallResultMessage(data.payload.name, data.payload.result ?? "Done")
    }
  })

  useRTVIClientEvent(RTVIEvent.BotLlmStarted, () => {
    startAssistantLlmStream()
    // Nudge a reset counter so any consumer logic can infer fresh turn if needed
    assistantStreamResetRef.current += 1
  })

  useRTVIClientEvent(RTVIEvent.BotLlmText, (data) => {
    updateAssistantText(data.text, false, "llm")
  })

  useRTVIClientEvent(RTVIEvent.BotLlmStopped, () => {
    finalizeLastMessage("assistant")
  })

  useRTVIClientEvent(RTVIEvent.BotTtsStarted, () => {
    // Start a new assistant message for TTS if there isn't one already in progress
    const store = useGameStore.getState()
    setBotHasSpoken(true)

    const lastAssistantIndex = store.chatMessages.findLastIndex(
      (msg: ConversationMessage) => msg.role === "assistant"
    )
    const lastAssistant =
      lastAssistantIndex !== -1 ? store.chatMessages[lastAssistantIndex] : undefined

    if (!lastAssistant || lastAssistant.final) {
      addChatMessage({
        role: "assistant",
        final: false,
        parts: [],
      })
    }
  })

  useRTVIClientEvent(RTVIEvent.BotTtsText, (data) => {
    updateAssistantText(data.text, false, "tts")
  })

  useRTVIClientEvent(RTVIEvent.BotTtsStopped, () => {
    // Finalize the TTS text stream
    const store = useGameStore.getState()
    const lastAssistant = store.chatMessages.findLast(
      (m: ConversationMessage) => m.role === "assistant"
    )

    if (lastAssistant && !lastAssistant.final) {
      finalizeLastMessage("assistant")
    }
  })

  useRTVIClientEvent(RTVIEvent.UserStartedSpeaking, () => {
    // Clear any pending cleanup timers
    clearTimeout(userStoppedTimeout.current)
  })

  useRTVIClientEvent(RTVIEvent.UserTranscript, (data) => {
    if (!hasReceivedInitialUserUnmute.current) {
      return
    }

    const text = data.text ?? ""
    const final = Boolean(data.final)
    upsertUserTranscript(text, final)

    // If we got any transcript, cancel pending cleanup
    clearTimeout(userStoppedTimeout.current)
  })

  useRTVIClientEvent(RTVIEvent.UserStoppedSpeaking, () => {
    clearTimeout(userStoppedTimeout.current)
    // If no transcript ends up arriving, ensure any accidental empty placeholder is removed.
    userStoppedTimeout.current = setTimeout(() => {
      const lastUser = useGameStore
        .getState()
        .chatMessages.findLast((m: ConversationMessage) => m.role === "user")
      const hasParts = Array.isArray(lastUser?.parts) && lastUser!.parts.length > 0
      if (!lastUser || !hasParts) {
        removeEmptyLastMessage("user")
      } else if (!lastUser.final) {
        finalizeLastMessage("user")
      }
    }, 3000)
  })

  // Memoize the filtered messages to prevent infinite loops
  const filteredMessages = useMemo(() => {
    // First, create messages with the appropriate text streams
    const messagesWithTextStreams = messages.map((message) => {
      if (message.role === "assistant") {
        const messageId = message.createdAt // Use createdAt as unique ID
        const textStream =
          textMode === "llm" ?
            llmTextStreams.get(messageId) || ""
          : ttsTextStreams.get(messageId) || ""

        return {
          ...message,
          parts:
            textStream ?
              [
                {
                  text: textStream,
                  final: message.final || false,
                  createdAt: message.createdAt,
                },
              ]
            : message.parts,
        }
      }
      return message
    })

    const processedMessages = mergeMessages(
      filterEmptyMessages(messagesWithTextStreams.sort(sortByCreatedAt))
    )

    return processedMessages
  }, [messages, llmTextStreams, ttsTextStreams, textMode])

  return {
    messages: filteredMessages,
  }
}
