import { useMemo, useRef } from "react"

import { RTVIEvent } from "@pipecat-ai/client-js"
import { useRTVIClientEvent } from "@pipecat-ai/client-react"

import {
  filterEmptyMessages,
  isMessageEmpty,
  mergeMessages,
  sortByCreatedAt,
} from "@/stores/chatSlice"
import useGameStore from "@/stores/game"

export type TextMode = "llm" | "tts"

interface Props {
  onMessageAdded?: (message: ConversationMessage) => void
  textMode?: TextMode
}

// Debug flag - set to true to enable verbose logging
const DEBUG_CHAT = true
const debugLog = (...args: unknown[]) => {
  if (DEBUG_CHAT) {
    console.log("[useChat]", ...args)
  }
}

export const useChat = ({ textMode = "llm" }: Props = {}) => {
  const userStoppedTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  const assistantStreamResetRef = useRef<number>(0)

  // Deduplication refs to handle React Strict Mode double-firing events
  const llmStreamIdRef = useRef<string>("")
  const llmAccumulatedLengthRef = useRef<number>(0)
  const lastUserTranscriptRef = useRef<string>("")
  const userTranscriptStreamIdRef = useRef<string>("")
  const ttsStreamIdRef = useRef<string>("")
  const ttsAccumulatedLengthRef = useRef<number>(0)

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
  const addToolCallMessage = useGameStore.use.addToolCallMessage()
  const setBotHasSpoken = useGameStore.use.setBotHasSpoken()

  useRTVIClientEvent(RTVIEvent.Connected, () => {
    clearMessages()
  })

  useRTVIClientEvent(RTVIEvent.BotLlmStarted, () => {
    // Generate new stream ID and reset tracking for deduplication
    const newStreamId = Date.now().toString()
    debugLog("BotLlmStarted - new stream:", newStreamId, "prev:", llmStreamIdRef.current)
    llmStreamIdRef.current = newStreamId
    llmAccumulatedLengthRef.current = 0

    startAssistantLlmStream()
    // Nudge a reset counter so any consumer logic can infer fresh turn if needed
    assistantStreamResetRef.current += 1
  })

  useRTVIClientEvent(RTVIEvent.BotLlmText, (data) => {
    // Deduplicate by checking actual store state
    // React Strict Mode registers two handlers - both fire for each event
    // We use the store's accumulated text length as source of truth
    const store = useGameStore.getState()
    const lastAssistant = store.chatMessages.findLast(
      (m: ConversationMessage) => m.role === "assistant"
    )
    const messageId = lastAssistant?.createdAt
    const currentStoreLength = messageId
      ? store.llmTextStreams.get(messageId)?.length ?? 0
      : 0

    // If store already has more text than our expected position, this is a duplicate
    const expectedPosition = llmAccumulatedLengthRef.current
    const isDuplicate = currentStoreLength > expectedPosition

    debugLog("BotLlmText", {
      text: data.text,
      expectedPosition,
      currentStoreLength,
      isDuplicate,
    })

    if (isDuplicate) {
      debugLog("BotLlmText SKIPPED (store already updated)")
      // Sync our ref to match store state
      llmAccumulatedLengthRef.current = currentStoreLength
      return
    }

    llmAccumulatedLengthRef.current += data.text.length
    updateAssistantText(data.text, false, "llm")
  })

  useRTVIClientEvent(RTVIEvent.BotLlmStopped, () => {
    debugLog("BotLlmStopped")
    finalizeLastMessage("assistant")
  })

  useRTVIClientEvent(RTVIEvent.BotTtsStarted, () => {
    // Generate new stream ID and reset tracking for TTS deduplication
    const newStreamId = Date.now().toString()
    debugLog("BotTtsStarted - new stream:", newStreamId)
    ttsStreamIdRef.current = newStreamId
    ttsAccumulatedLengthRef.current = 0

    // Bot is committed to speaking - finalize user turn
    setBotHasSpoken(true)
    finalizeLastMessage("user")

    // Start a new assistant message for TTS if there isn't one already in progress
    const store = useGameStore.getState()
    const lastAssistantIndex = store.chatMessages.findLastIndex(
      (msg: ConversationMessage) => msg.role === "assistant"
    )
    const lastAssistant =
      lastAssistantIndex !== -1
        ? store.chatMessages[lastAssistantIndex]
        : undefined

    debugLog("BotTtsStarted - lastAssistant:", lastAssistant?.final, "creating new:", !lastAssistant || lastAssistant.final)
    if (!lastAssistant || lastAssistant.final) {
      addChatMessage({
        role: "assistant",
        final: false,
        parts: [],
      })
    }
  })

  useRTVIClientEvent(RTVIEvent.BotTtsText, (data) => {
    // Deduplicate by checking actual store state
    const store = useGameStore.getState()
    const lastAssistant = store.chatMessages.findLast(
      (m: ConversationMessage) => m.role === "assistant"
    )
    const messageId = lastAssistant?.createdAt
    const currentStoreLength = messageId
      ? store.ttsTextStreams.get(messageId)?.length ?? 0
      : 0

    const expectedPosition = ttsAccumulatedLengthRef.current
    const isDuplicate = currentStoreLength > expectedPosition

    debugLog("BotTtsText", {
      text: data.text,
      expectedPosition,
      currentStoreLength,
      isDuplicate,
    })

    if (isDuplicate) {
      debugLog("BotTtsText SKIPPED (store already updated)")
      ttsAccumulatedLengthRef.current = currentStoreLength
      return
    }

    ttsAccumulatedLengthRef.current += data.text.length
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
    debugLog("UserStartedSpeaking")
    // Clear any pending cleanup timers
    clearTimeout(userStoppedTimeout.current)
    // User turn is now open - reset the flag
    setBotHasSpoken(false)
    // Reset transcript deduplication for new utterance
    userTranscriptStreamIdRef.current = Date.now().toString()
    lastUserTranscriptRef.current = ""
  })

  useRTVIClientEvent(RTVIEvent.UserTranscript, (data) => {
    const text = data.text ?? ""
    const final = Boolean(data.final)

    // Deduplicate: skip if we've already processed this exact transcript in this utterance
    const transcriptKey = `${userTranscriptStreamIdRef.current}:${final}:${text}`
    const isDuplicate = lastUserTranscriptRef.current === transcriptKey
    debugLog("UserTranscript", { text, final, isDuplicate })
    if (isDuplicate) {
      debugLog("UserTranscript SKIPPED (duplicate)")
      return // Duplicate event
    }
    lastUserTranscriptRef.current = transcriptKey

    upsertUserTranscript(text, final)

    // If we got any transcript, cancel pending cleanup
    clearTimeout(userStoppedTimeout.current)
  })

  useRTVIClientEvent(RTVIEvent.UserStoppedSpeaking, () => {
    debugLog("UserStoppedSpeaking")
    // Don't finalize here anymore - wait for BotTtsStarted
    // Only clean up truly empty messages after a longer delay
    clearTimeout(userStoppedTimeout.current)
    userStoppedTimeout.current = setTimeout(() => {
      const lastUser = useGameStore
        .getState()
        .chatMessages.findLast((m: ConversationMessage) => m.role === "user")
      if (!lastUser || isMessageEmpty(lastUser)) {
        removeEmptyLastMessage("user")
      }
    }, 10000) // Longer timeout just for cleanup
  })

  // Handle function call messages from server
  useRTVIClientEvent(RTVIEvent.ServerMessage, (data) => {
    if (data?.event === "llm.function_call" && data?.payload?.name) {
      addToolCallMessage(data.payload.name)
    }
  })

  // Memoize the filtered messages to prevent infinite loops
  const filteredMessages = useMemo(() => {
    // First, create messages with the appropriate text streams
    const messagesWithTextStreams = messages.map((message) => {
      if (message.role === "assistant") {
        const messageId = message.createdAt // Use createdAt as unique ID
        const textStream =
          textMode === "llm"
            ? llmTextStreams.get(messageId) || ""
            : ttsTextStreams.get(messageId) || ""

        return {
          ...message,
          parts: textStream
            ? [
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
