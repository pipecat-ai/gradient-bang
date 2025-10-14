import useGameStore from "@/stores/game";
import Connect from "@views/Connect";
import Error from "@views/Error";
import Game from "@views/Game";
import Title from "@views/Title";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";

export const ViewContainer = ({
  error,
  onConnect,
}: {
  onConnect?: () => void;
  error?: string | null;
}) => {
  const settings = useGameStore.use.settings();
  const [viewState, setViewState] = useState<"title" | "game">(
    settings.bypassTitleScreen ? "game" : "title"
  );

  const handleViewStateChange = useCallback((state: "title" | "game") => {
    setViewState(state);
  }, []);

  // Show errors first
  if (error) {
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
            <Connect connectHandler={onConnect} />
            <Game />
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
};

export default ViewContainer;
