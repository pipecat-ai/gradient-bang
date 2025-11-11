import { usePlaySound } from "@/hooks/usePlaySound";
import useGameStore from "@/stores/game";
import { ScrambleText, type ScrambleTextRef } from "@fx/ScrambleText";
import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

const useDelayedVisibility = (value: boolean, delay: number) => {
  const [delayedValue, setDelayedValue] = useState(value);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (value) {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = window.setTimeout(() => {
        setDelayedValue(true);
        timeoutRef.current = null;
      }, delay);
    } else {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      setDelayedValue(false);
    }

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [value, delay]);

  return delayedValue;
};

export const SectorTitleBanner = () => {
  const { playSound } = usePlaySound();
  const starfieldInstance = useGameStore.use.starfieldInstance?.();
  const sector = useGameStore.use.sector?.();
  const [isVisible, setIsVisible] = useState(false);
  const [skipExit, setSkipExit] = useState(false);
  const scrambleRef = useRef<ScrambleTextRef>(null);
  const debouncedVisible = useDelayedVisibility(isVisible, 2000);
  const [scope, animate] = useAnimate();
  const hideTimerRef = useRef<number | null>(null);
  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const sectorText = `SECTOR ${sector?.id.toString() || "unknown"}`;

  useEffect(() => {
    if (!debouncedVisible) {
      clearHideTimer();
      scrambleRef.current?.scrambleOut();
      return;
    }

    // Ensure skip flag is reset whenever we show again
    setSkipExit(false);

    clearHideTimer();

    hideTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
      hideTimerRef.current = null;
    }, 3000);

    return clearHideTimer;
  }, [debouncedVisible, clearHideTimer]);

  const onSceneChange = useCallback(() => {
    setSkipExit(false);

    const shouldDisplay = (starfieldInstance?.getWarpQueueLength() ?? 0) === 0;
    setIsVisible(shouldDisplay);
  }, [starfieldInstance]);

  useEffect(() => {
    if (!debouncedVisible) return;
    playSound("text", { volume: 0.1 });
  }, [playSound, debouncedVisible]);

  useEffect(() => {
    if (sector) {
      return;
    }

    clearHideTimer();
    setIsVisible(false);
  }, [sector, clearHideTimer]);

  const onWarpStart = useCallback(async () => {
    clearHideTimer();

    if (!debouncedVisible) {
      setSkipExit(false);
      setIsVisible(false);
      return;
    }

    scrambleRef.current?.scrambleOut(250);
    setSkipExit(true);
    await animate(
      scope.current,
      { opacity: 0 },
      { duration: 0.25, ease: "easeOut" }
    );
    setIsVisible(false);
  }, [animate, clearHideTimer, debouncedVisible, scope]);

  useEffect(() => {
    if (!starfieldInstance) return;

    starfieldInstance.on("sceneReady", onSceneChange);
    starfieldInstance.on("warpStart", onWarpStart);

    return () => {
      starfieldInstance.off("sceneReady", onSceneChange);
      starfieldInstance.off("warpStart", onWarpStart);
    };
  }, [starfieldInstance, onSceneChange, onWarpStart]);

  return (
    <AnimatePresence>
      {debouncedVisible && (
        <motion.div
          ref={scope}
          key={`sector-${sector?.id}`}
          initial={{ opacity: 0 }}
          animate={{
            opacity: 1,
            transition: { duration: 0.4, ease: "easeOut" },
          }}
          exit={
            skipExit
              ? undefined
              : { opacity: 0, transition: { duration: 2, ease: "easeOut" } }
          }
          className="w-full absolute left-0 top-1/2 -translate-y-1/2 z-20"
        >
          <div className="flex flex-row gap-5 text-center justify-center items-center mx-auto w-max bg-background/30 p-2">
            <div className="bg-dotted-sm self-stretch w-[160px]" />
            <p className="text-white text-xl font-bold uppercase tracking-wider leading-tight">
              <ScrambleText ref={scrambleRef}>{sectorText}</ScrambleText>
            </p>
            <div className="bg-dotted-sm self-stretch w-[160px]" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
