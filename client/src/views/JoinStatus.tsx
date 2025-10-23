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

  /*
  // Update connection string when connected
  useEffect(() => {
    if (isConnected) {
      setConnectionString("Configuring game UI...");
    }
  }, [isConnected]);

  // When game state becomes ready, trigger fade out
  useEffect(() => {
    if (gameState === "ready") {
      setShouldFadeOut(true);
    }
  }, [gameState]);

  // Initialize connection
  useEffect(() => {
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.start("status-panel");
  }, []);

  // Handle fade out complete: clear FX and hide entire element
  const handleFadeComplete = () => {
    if (shouldFadeOut) {
      const fx = useGameStore.getState().diamondFXInstance;
      fx?.update({
        onComplete: () => {
          setShowConnectScreen(false);
        },
      });
      fx?.clear(true);
    }
  };
*/

  return (
    <div className="absolute inset-0 z-999 h-full w-full flex items-center justify-center bg-white/20 backdrop-blur-sm pointer-events-none user-select-none">
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
              className="uppercase relative animate-pulse"
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
