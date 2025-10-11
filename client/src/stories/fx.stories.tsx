import useGameStore from "@/stores/game";
import { AnimatedFrame, PERFORMANCE_PRESETS } from "@fx/frame";
import type { Story } from "@ladle/react";
import { useState } from "react";

export const DiamondAnimation: Story = () => {
  const [started, setStarted] = useState(false);

  const startAnimation = (wait = false) => {
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.start("demo-panel", wait);
    setStarted(true);
  };

  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.0 }} />

      <div
        id="demo-panel"
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[400px]"
      >
        <h2 className="text-white text-xl font-semibold mb-2">Demo Panel</h2>
        <p className="text-white/80 text-sm mb-4">
          Lines draw from corners, morph into a diamond, blink, spin, then dock
          at this panel's corners.
        </p>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => startAnimation(false)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
          >
            ▶ Start
          </button>
          <button
            onClick={() => startAnimation(true)}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm"
          >
            ▶ Start (Hold on Blink)
          </button>
          {started && (
            <>
              <button
                onClick={() =>
                  useGameStore.getState().diamondFXInstance?.resume()
                }
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm"
              >
                Resume
              </button>
              <button
                onClick={() =>
                  useGameStore.getState().diamondFXInstance?.clear()
                }
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm"
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

DiamondAnimation.meta = {
  disconnectedStory: true,
};

export const HalfMode: Story = () => {
  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ half: true, shadowBlur: 1.5 }} />

      <div
        id="demo-panel-half"
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[400px]"
      >
        <h2 className="text-white text-xl font-semibold mb-2">
          Half Mode Demo
        </h2>
        <p className="text-white/80 text-sm mb-4">
          Skips the corner-to-center phase and starts from the center diamond.
        </p>
        <button
          onClick={() =>
            useGameStore.getState().diamondFXInstance?.start("demo-panel-half")
          }
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
        >
          ▶ Start Half Mode
        </button>
      </div>
    </div>
  );
};

HalfMode.meta = {
  disconnectedStory: true,
};

export const ColorVariations: Story = () => {
  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.2 }} />

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-8">
        <div
          id="blue-panel"
          className="bg-blue-900/20 backdrop-blur-md border border-blue-500/30 rounded-xl p-6 min-w-[250px]"
        >
          <h3 className="text-blue-300 text-lg font-semibold mb-2">Blue</h3>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.update({ lineColor: "rgba(59, 130, 246, 0.95)" });
              fx?.start("blue-panel");
            }}
            className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
          >
            ▶ Animate
          </button>
        </div>

        <div
          id="green-panel"
          className="bg-green-900/20 backdrop-blur-md border border-green-500/30 rounded-xl p-6 min-w-[250px]"
        >
          <h3 className="text-green-300 text-lg font-semibold mb-2">Green</h3>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.update({ lineColor: "rgba(34, 197, 94, 0.95)" });
              fx?.start("green-panel");
            }}
            className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm"
          >
            ▶ Animate
          </button>
        </div>

        <div
          id="red-panel"
          className="bg-red-900/20 backdrop-blur-md border border-red-500/30 rounded-xl p-6 min-w-[250px]"
        >
          <h3 className="text-red-300 text-lg font-semibold mb-2">Red</h3>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.update({ lineColor: "rgba(239, 68, 68, 0.95)" });
              fx?.start("red-panel");
            }}
            className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm"
          >
            ▶ Animate
          </button>
        </div>
      </div>
    </div>
  );
};

ColorVariations.meta = {
  disconnectedStory: true,
};

export const PerformancePresets: Story = () => {
  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={PERFORMANCE_PRESETS.mid} />

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-8">
        <div
          id="low-panel"
          className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[200px]"
        >
          <h3 className="text-white text-lg font-semibold mb-1">Low</h3>
          <p className="text-white/60 text-xs mb-3">
            No shadow, faster timings
          </p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.update(PERFORMANCE_PRESETS.low);
              fx?.start("low-panel");
            }}
            className="w-full px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg text-sm"
          >
            ▶ Test
          </button>
        </div>

        <div
          id="mid-panel"
          className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[200px]"
        >
          <h3 className="text-white text-lg font-semibold mb-1">Mid</h3>
          <p className="text-white/60 text-xs mb-3">Balanced performance</p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.update(PERFORMANCE_PRESETS.mid);
              fx?.start("mid-panel");
            }}
            className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
          >
            ▶ Test
          </button>
        </div>

        <div
          id="high-panel"
          className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[200px]"
        >
          <h3 className="text-white text-lg font-semibold mb-1">High</h3>
          <p className="text-white/60 text-xs mb-3">
            Full effects, slower timings
          </p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.update(PERFORMANCE_PRESETS.high);
              fx?.start("high-panel");
            }}
            className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm"
          >
            ▶ Test
          </button>
        </div>
      </div>
    </div>
  );
};

PerformancePresets.meta = {
  disconnectedStory: true,
};

export const TargetSwitching: Story = () => {
  const [currentTarget, setCurrentTarget] = useState<string | null>(null);

  const switchTo = (targetId: string) => {
    useGameStore.getState().diamondFXInstance?.start(targetId);
    setCurrentTarget(targetId);
  };

  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.0 }} />

      <div className="absolute top-8 left-1/2 -translate-x-1/2 text-white/60 text-sm">
        Current Target: {currentTarget || "None"}
      </div>

      <div
        id="target-1"
        className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-4"
      >
        <h3 className="text-white text-sm font-semibold mb-2">Target 1</h3>
        <button
          onClick={() => switchTo("target-1")}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs"
        >
          Switch Here
        </button>
      </div>

      <div
        id="target-2"
        className="absolute top-1/4 right-1/4 translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-4"
      >
        <h3 className="text-white text-sm font-semibold mb-2">Target 2</h3>
        <button
          onClick={() => switchTo("target-2")}
          className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-xs"
        >
          Switch Here
        </button>
      </div>

      <div
        id="target-3"
        className="absolute bottom-1/4 left-1/4 -translate-x-1/2 translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-4"
      >
        <h3 className="text-white text-sm font-semibold mb-2">Target 3</h3>
        <button
          onClick={() => switchTo("target-3")}
          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-xs"
        >
          Switch Here
        </button>
      </div>

      <div
        id="target-4"
        className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-4"
      >
        <h3 className="text-white text-sm font-semibold mb-2">Target 4</h3>
        <button
          onClick={() => switchTo("target-4")}
          className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-xs"
        >
          Switch Here
        </button>
      </div>
    </div>
  );
};

TargetSwitching.meta = {
  disconnectedStory: true,
};

export const StoreBasedUsage: Story = () => {
  const diamondFX = useGameStore((state) => state.diamondFXInstance);

  const startAnimation = () => {
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.start("store-demo-panel");
  };

  const clearAnimation = () => {
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.clear();
  };

  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.0 }} />

      <div
        id="store-demo-panel"
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[400px]"
      >
        <h2 className="text-white text-xl font-semibold mb-2">
          Store-Based Demo
        </h2>
        <p className="text-white/80 text-sm mb-4">
          This version stores the DiamondFX instance in the game store. Access
          it via <code className="bg-black/30 px-1 rounded">useGameStore</code>.
        </p>
        <div className="text-white/60 text-xs mb-4">
          Instance loaded: {diamondFX ? "✅ Yes" : "❌ No"}
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={startAnimation}
            disabled={!diamondFX}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm"
          >
            ▶ Start Animation
          </button>
          <button
            onClick={clearAnimation}
            disabled={!diamondFX}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
};

StoreBasedUsage.meta = {
  disconnectedStory: true,
};
