import useGameStore from "@stores/game";
import { useCallback, useEffect, useRef } from "react";

import { usePlaySound } from "./usePlaySound";

const COOLDOWN_MS = 5000;

export const useNotificationSound = () => {
  const playSound = usePlaySound();
  const prevCountRef = useRef<number | null>(null);
  const lastPlayedRef = useRef(0);
  const prevAlertTransferRef = useRef<number | null>(null);

  const messageCount = useGameStore.use.getIncomingMessageLength()();
  const alertTransfer = useGameStore.use.alertTransfer();

  const tryPlayNotification = useCallback(() => {
    const now = Date.now();
    if (now - lastPlayedRef.current < COOLDOWN_MS) {
      return;
    }

    playSound("message");
    lastPlayedRef.current = now;
  }, [playSound]);

  useEffect(() => {
    if (prevCountRef.current === null) {
      prevCountRef.current = messageCount;
      return;
    }

    const hasNewMessages =
      messageCount > prevCountRef.current && messageCount > 0;

    if (hasNewMessages) {
      tryPlayNotification();
    }

    prevCountRef.current = messageCount;
  }, [messageCount, tryPlayNotification]);

  useEffect(() => {
    if (prevAlertTransferRef.current === null) {
      prevAlertTransferRef.current = alertTransfer;
      return;
    }

    if (alertTransfer === prevAlertTransferRef.current) {
      return;
    }

    tryPlayNotification();
    prevAlertTransferRef.current = alertTransfer;
  }, [alertTransfer, tryPlayNotification]);
};
