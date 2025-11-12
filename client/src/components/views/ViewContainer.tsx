import { useGameContext } from "@/hooks/useGameContext";
import { checkAssetsAreCached } from "@/utils/cache";
import useGameStore from "@stores/game";
import { Error } from "@views/Error";
import { Game } from "@views/Game";
import { JoinStatus } from "@views/JoinStatus";
import { Preload } from "@views/Preload";
import { Title } from "@views/Title";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";

export const ViewContainer = ({ error }: { error?: string | null }) => {
  const settings = useGameStore.use.settings();
  const gameState = useGameStore.use.gameState();
  const { initialize } = useGameContext();

  const [viewState, setViewState] = useState<"title" | "preload" | "game">(
    settings.bypassTitleScreen ? "preload" : "title"
  );

  const handleViewStateChange = useCallback(
    (state: "title" | "preload" | "game") => {
      // If transitioning to preload, check if assets are already cached
      if (state === "preload") {
        const cached = checkAssetsAreCached();

        if (cached) {
          console.log("[GAME] Assets already cached, skipping preload screen");
          setViewState("game");
          return;
        }

        console.log("[GAME] Cache incomplete, showing preload screen");
      }

      setViewState(state);
    },
    []
  );

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
          <Title
            onViewNext={() => {
              handleViewStateChange("preload");
            }}
          />
        )}
        {viewState === "preload" && (
          <Preload onComplete={() => handleViewStateChange("game")} />
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
