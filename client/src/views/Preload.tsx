import { useAssetPreloader } from "@/hooks/useAssetPreloader";
import { wait } from "@/utils/animation";
import { useEffect } from "react";

interface PreloadProps {
  onComplete: () => void;
}

export const Preload = ({ onComplete }: PreloadProps) => {
  const { preloadAll, progress, isComplete } = useAssetPreloader();

  useEffect(() => {
    preloadAll();
  }, [preloadAll]);

  useEffect(() => {
    if (isComplete) {
      wait(1000).then(() => {
        onComplete();
      });
    }
  }, [isComplete, onComplete]);

  return (
    <div className="relative h-screen w-screen overflow-hidden flex items-center justify-center">
      <div className="max-w-md w-full px-8">
        {/* Title */}
        <div className="text-2xl mb-8 text-center animate-pulse">
          GRADIENT BANG
        </div>

        {/* Progress Bar */}
        <div className="mb-4">
          <div className="w-full h-2 bg-gray-900 rounded overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all duration-300 ease-out"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
        </div>

        {/* Stats */}
        <div className="flex justify-between text-sm mb-6 opacity-70">
          <span>
            {progress.loaded} / {progress.total}
          </span>
          <span>{progress.percentage}%</span>
        </div>

        {/* Current Asset */}
        <div className="text-center text-sm">
          <div className="opacity-50 mb-1">
            {progress.currentType?.toUpperCase()}
          </div>
          <div>{progress.message}</div>
        </div>

        {/* Error State */}
        {progress.phase === "error" && (
          <div className="mt-4 p-4 bg-red-900 bg-opacity-20 border border-red-500 rounded text-red-500 text-sm">
            {progress.message}
          </div>
        )}
      </div>
    </div>
  );
};
