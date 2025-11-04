import useGameStore from "@/stores/game";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

export const JoinStatus = ({ handleStart }: { handleStart: () => void }) => {
  const [showPanel, setShowPanel] = useState(false);
  const gameState = useGameStore.use.gameState();
  const gameStateMessage = useGameStore.use.gameStateMessage?.();
  const diamondFXInstance = useGameStore.use.diamondFXInstance?.();

  useEffect(() => {
    if (gameState !== "not_ready" || !diamondFXInstance) return;

    diamondFXInstance.update({
      onComplete: () => {
        setShowPanel(true);
      },
    });
    diamondFXInstance.start("status-panel");
  }, [gameState, diamondFXInstance]);

  useEffect(() => {
    if (gameState !== "ready" || !diamondFXInstance) return;

    diamondFXInstance?.clear(true);
  }, [gameState, diamondFXInstance]);

  return (
    <div className="absolute inset-0 z-90 h-full w-full flex items-center justify-center bg-gray-800/20 backdrop-blur-lg bg-dotted-lg bg-dotted-white/10 bg-center pointer-events-none user-select-none">
      <motion.div
        animate={{ opacity: showPanel ? 1 : 0 }}
        initial={{ opacity: 0 }}
        transition={{ duration: 1 }}
        onAnimationComplete={() => {
          if (gameState !== "not_ready") return;
          handleStart();
        }}
      >
        <div id="status-panel" className="screen p-4">
          <AnimatePresence mode="wait">
            <motion.span
              key={gameStateMessage}
              initial={{ opacity: 0, y: -10 }}
              animate={{
                opacity: 1,
                transition: { duration: 0.3, delay: 0.2 },
              }}
              exit={{ opacity: 0, y: 10, transition: { duration: 0.3 } }}
              className="uppercase relative animate-pulse text-center tracking-widest"
            >
              {gameStateMessage}
            </motion.span>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
};

export default JoinStatus;
