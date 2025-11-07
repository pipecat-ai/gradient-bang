import { PortPanel } from "@/components/PortPanel";
import useGameStore from "@/stores/game";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { MapScreen } from "./MapScreen";

const variants = {
  enter: {
    opacity: 1,
    transition: { delay: 0.4, duration: 0.3, easing: "ease-in-out" },
  },
  exit: { opacity: 0, transition: { duration: 0.2, easing: "ease-in-out" } },
};

const ScreenBase = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="screen focus:outline-none">
      <div className="relative z-1 p-4">{children}</div>
    </div>
  );
};

export const ScreenContainer = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  const activeScreen = useGameStore.use.activeScreen?.();
  const prevActiveScreenRef = useRef<UIScreen | undefined>(activeScreen);
  const diamondFXInstance = useGameStore.use.diamondFXInstance?.();
  const setActiveScreen = useGameStore.use.setActiveScreen?.();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    switch (e.key) {
      case "Home":
      case "End":
      case "Escape":
        e.preventDefault();
        setActiveScreen(undefined);
        break;
      default:
        return;
    }
  };

  useEffect(() => {
    if (prevActiveScreenRef.current && !activeScreen) {
      diamondFXInstance?.clear(true);
    }
    prevActiveScreenRef.current = activeScreen;
  }, [activeScreen, diamondFXInstance]);

  useEffect(() => {
    if (activeScreen && containerRef.current) {
      containerRef.current.focus();
    }
  }, [activeScreen]);

  return (
    <div className="absolute inset-ui-lg z-(--z-screens) flex items-center justify-center">
      <div
        id="screen-container"
        className="relative max-h-min max-w-min focus:outline-none"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        ref={containerRef}
      >
        <AnimatePresence
          mode="wait"
          onExitComplete={() => {
            if (activeScreen && !diamondFXInstance?.isAnimating) {
              diamondFXInstance?.start("screen-container", false, true, {
                half: true,
              });
            }
          }}
        >
          <motion.div
            key={activeScreen}
            variants={variants}
            initial="exit"
            animate="enter"
            exit="exit"
          >
            {activeScreen === "self" && <ScreenBase>Self</ScreenBase>}
            {activeScreen === "messaging" && <ScreenBase>Messaging</ScreenBase>}
            {activeScreen === "trading" && (
              <ScreenBase>
                <PortPanel />
              </ScreenBase>
            )}
            {activeScreen === "map" && (
              <ScreenBase>
                <MapScreen />
              </ScreenBase>
            )}
            {activeScreen === "tasks" && <ScreenBase>Tasks</ScreenBase>}
            {activeScreen === "combat" && <ScreenBase>Combat</ScreenBase>}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};
