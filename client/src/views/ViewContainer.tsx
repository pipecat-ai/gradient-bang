import { useGameContext } from "@/hooks/useGameContext";
import useGameStore from "@stores/game";
import Error from "@views/Error";
import Game from "@views/Game";
import JoinStatus from "@views/JoinStatus";
import Title from "@views/Title";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";

export const ViewContainer = ({ error }: { error?: string | null }) => {
  const settings = useGameStore.use.settings();
  const gameState = useGameStore.use.gameState();
  const { initialize } = useGameContext();

  const [viewState, setViewState] = useState<"title" | "game">(
    settings.bypassTitleScreen ? "game" : "title"
  );

  const handleViewStateChange = useCallback((state: "title" | "game") => {
    setViewState(state);
  }, []);

  if (error || gameState === "error") {
    return <Error>{error}</Error>;
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={viewState}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4, ease: "easeInOut" }}
        className="relative h-screen w-screen overflow-hidden"
      >
        {viewState === "title" && (
          <Title onViewNext={() => handleViewStateChange("game")} />
        )}
        {viewState === "game" && (
          <>
            <AnimatePresence>
              {gameState !== "ready" && (
                <motion.div
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5 }}
                >
                  <JoinStatus
                    handleStart={() => {
                      if (gameState !== "not_ready") return;
                      initialize();
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            <Game />
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
};

export default ViewContainer;
