import useGameStore from "@stores/game";
import { useEffect, useRef } from "react";
import { usePlaySound } from "./usePlaySound";

export const useMessageNotificationSound = () => {
  const playSound = usePlaySound();
  const prevCountRef = useRef(0);
  const lastPlayedRef = useRef(0);

  const messageCount = useGameStore.use.getIncomingMessageLength()();

  const COOLDOWN_MS = 3000;

  useEffect(() => {
    if (messageCount > prevCountRef.current && messageCount > 0) {
      const now = Date.now();

      if (now - lastPlayedRef.current >= COOLDOWN_MS) {
        console.debug("[GAME] Playing incoming message sound");
        playSound("message");
        lastPlayedRef.current = now;
      }
    }

    prevCountRef.current = messageCount;
  }, [messageCount, playSound]);
};
