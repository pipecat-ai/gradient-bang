import { useCallback, useEffect, useRef } from "react"

import useAudioStore from "@/stores/audio"
import useGameStore, { selectIncomingMessageCount } from "@/stores/game"

const COOLDOWN_MS = 5000

export const useNotificationSound = () => {
  const playSound = useAudioStore.use.playSound()
  const prevCountRef = useRef<number | null>(null)
  const lastPlayedRef = useRef(0)
  const prevAlertTransferRef = useRef<number | null>(null)

  const messages = useGameStore.use.messages()
  const messageCount = useGameStore(selectIncomingMessageCount)
  const alertTransfer = useGameStore.use.alertTransfer()
  // Track whether messages have been initialized (null -> array transition)
  const messagesInitializedRef = useRef(messages !== null)

  const tryPlayNotification = useCallback(() => {
    const now = Date.now()
    if (now - lastPlayedRef.current < COOLDOWN_MS) {
      return
    }

    playSound("message")
    lastPlayedRef.current = now
  }, [playSound])

  useEffect(() => {
    // When messages transitions from null to an array (history load),
    // just sync the count without playing a sound
    if (!messagesInitializedRef.current) {
      if (messages !== null) {
        messagesInitializedRef.current = true
      }
      prevCountRef.current = messageCount
      return
    }

    if (prevCountRef.current === null) {
      prevCountRef.current = messageCount
      return
    }

    const hasNewMessages = messageCount > prevCountRef.current && messageCount > 0

    if (hasNewMessages) {
      tryPlayNotification()
    }

    prevCountRef.current = messageCount
  }, [messages, messageCount, tryPlayNotification])

  useEffect(() => {
    if (prevAlertTransferRef.current === null) {
      prevAlertTransferRef.current = alertTransfer
      return
    }

    if (alertTransfer === prevAlertTransferRef.current) {
      return
    }

    tryPlayNotification()
    prevAlertTransferRef.current = alertTransfer
  }, [alertTransfer, tryPlayNotification])
}
