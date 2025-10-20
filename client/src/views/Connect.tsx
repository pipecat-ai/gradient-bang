import { AnimatedFrame } from "@/fx/frame";
import { usePipecatConnectionState } from "@/hooks/usePipecatState";

import useGameStore from "@/stores/game";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

export const Connect = ({
  connectHandler,
}: {
  onViewNext: () => void;
  connectHandler?: () => void;
}) => {
  const [showConnectScreen, setShowConnectScreen] = useState(true);
  const [shouldFadeOut, setShouldFadeOut] = useState(false);
  const { isConnected } = usePipecatConnectionState();
  const [connectionString, setConnectionString] = useState(
    "Connecting to server..."
  );
  const gameState = useGameStore.use.gameState();

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
    setTimeout(() => connectHandler?.(), 1000);
  }, [connectHandler]);

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

  if (!showConnectScreen) {
    return <AnimatedFrame />;
  }

  return (
    <>
      <motion.div
        animate={{ opacity: shouldFadeOut ? 0 : 1 }}
        initial={{ opacity: 0 }}
        transition={{ duration: shouldFadeOut ? 1 : 2 }}
        onAnimationComplete={handleFadeComplete}
        className="absolute inset-0 z-[999] h-full w-full flex items-center justify-center bg-white/20 backdrop-blur-sm pointer-events-none user-select-none"
      >
        <div id="status-panel" className="screen p-4">
          <span className="animate-pulse uppercase">{connectionString}</span>
        </div>
      </motion.div>
      <AnimatedFrame />
    </>
  );
};

export default Connect;
