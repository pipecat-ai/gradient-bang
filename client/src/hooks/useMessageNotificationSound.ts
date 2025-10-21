import useGameStore from "@stores/game";
import { useEffect, useRef } from "react";
import { usePlaySound } from "./usePlaySound";

export const useMessageNotificationSound = () => {
  const playSound = usePlaySound();
  const prevCountRef = useRef(0);
  const isFirstRenderRef = useRef(true);
  const lastPlayedRef = useRef(0);

  const messageCount = useGameStore((state) => state.messages.length);

  const COOLDOWN_MS = 5000;

  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      prevCountRef.current = messageCount;
      return;
    }

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
