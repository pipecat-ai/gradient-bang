import Settings from "../settings.json";
import useGameStore from "../stores/game";

export const Debug = () => {
  if (!Settings.debugMode) return null;

  const uiState = useGameStore.use.uiState();

  return (
    <div className="absolute top-0 left-0 bg-black/80 z-90 text-xs text-white p-2 flex flex-col gap-2">
      <div className="flex flex-row gap-2 justify-between items-center">
        UI State: <span className="font-bold">{uiState}</span>
      </div>
    </div>
  );
};
