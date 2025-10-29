import useGameStore from "@/stores/game";
import { AnimatePresence, motion } from "motion/react";
//import { useEffect, useState } from "react";

export const SectorTitleBanner = () => {
  const sector = useGameStore.use.sector?.();

  const sectorId = sector?.id.toString() || "unknown";

  //if (!sector) return null;

  return (
    <AnimatePresence>
      <motion.div
        key={sectorId}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{
          duration: 0.4,
          ease: "easeOut",
        }}
        className="w-full h-full absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none"
      >
        <h1 className="text-white text-2xl font-bold">{sectorId}</h1>
      </motion.div>
    </AnimatePresence>
  );
};
