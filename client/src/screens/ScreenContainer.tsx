import useGameStore from "@/stores/game";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";

const variants = {
  enter: {
    opacity: 1,
    transition: { delay: 0.4, duration: 0.3, easing: "ease-in-out" },
  },
  exit: { opacity: 0, transition: { duration: 0.2, easing: "ease-in-out" } },
};

const ScreenBase = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="screen">
      <div className="relative z-1 p-4">{children}</div>
    </div>
  );
};

export const ScreenContainer = () => {
  const activeScreen = useGameStore.use.activeScreen?.();
  const diamondFXInstance = useGameStore.use.diamondFXInstance?.();

  useEffect(() => {
    if (!activeScreen) {
      diamondFXInstance?.clear(true);
      diamondFXInstance?.update({ half: true });
    }
  }, [activeScreen, diamondFXInstance]);

  return (
    <>
      <div id="screen-container" className="relative max-h-min max-w-min">
        <AnimatePresence
          mode="wait"
          onExitComplete={() => {
            console.log("onExitComplete", activeScreen);

            if (activeScreen && !diamondFXInstance?.isAnimating) {
              diamondFXInstance?.start("screen-container", false, true);
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
            {activeScreen === "trading" && <ScreenBase>Trading</ScreenBase>}
            {activeScreen === "map" && <ScreenBase>Map</ScreenBase>}
            {activeScreen === "tasks" && <ScreenBase>Tasks</ScreenBase>}
            {activeScreen === "combat" && <ScreenBase>Combat</ScreenBase>}
          </motion.div>
        </AnimatePresence>
      </div>
    </>
  );
};
