import useGameStore from "@/stores/game";
import { Badge } from "@pipecat-ai/voice-ui-kit";
import { differenceInSeconds } from "date-fns";
import { useEffect, useRef, useState } from "react";

export const CombatTimerBadge = () => {
  const activeCombatSession = useGameStore.use.activeCombatSession();
  const [timeRemaining, setTimeRemaining] = useState(0);
  const serverTimeOffsetRef = useRef<number>(0);
  const localStartTimeRef = useRef<number>(0);

  useEffect(() => {
    const deadline = activeCombatSession?.deadline;
    const serverCurrentTime = activeCombatSession?.current_time;

    if (!deadline || !serverCurrentTime) {
      setTimeRemaining(0);
      return;
    }

    // Calculate the offset between server time and local time
    const serverTime = new Date(serverCurrentTime).getTime();
    const localTime = Date.now();
    serverTimeOffsetRef.current = serverTime - localTime;
    localStartTimeRef.current = localTime;

    const deadlineDate = new Date(deadline);

    // Update timer function
    const updateTimer = () => {
      const localNow = Date.now();
      const estimatedServerTime = localNow + serverTimeOffsetRef.current;
      const remaining = differenceInSeconds(
        deadlineDate,
        new Date(estimatedServerTime)
      );
      setTimeRemaining(remaining > 0 ? remaining : 0);
    };

    updateTimer();

    // Update every second
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [activeCombatSession?.deadline, activeCombatSession?.current_time]);

  return <Badge variant="bracket">Combat Timer: {timeRemaining}s</Badge>;
};
