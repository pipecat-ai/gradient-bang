import useGameStore from "@/stores/game";
import { AnimatedFrame, PERFORMANCE_PRESETS } from "@fx/frame";
import type { Story } from "@ladle/react";
import { useEffect, useState } from "react";

export const DiamondAnimation: Story = () => {
  const [started, setStarted] = useState(false);

  const startAnimation = (wait = false, config?: object) => {
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.start("demo-panel", wait, true, config);
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
          <button
            onClick={() =>
              startAnimation(false, {
                half: true,
                lineColor: "rgba(0, 255, 127, 0.95)",
              })
            }
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm"
          >
            ▶ Start (Half Mode + Green)
          </button>
          {started && (
            <>
              <button
                onClick={() =>
                  useGameStore.getState().diamondFXInstance?.resume()
                }
                className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm"
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
      <AnimatedFrame config={{ shadowBlur: 1.5 }} />

      <div
        id="demo-panel-half"
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[400px]"
      >
        <h2 className="text-white text-xl font-semibold mb-2">
          Half Mode Demo
        </h2>
        <p className="text-white/80 text-sm mb-4">
          Skips the corner-to-center phase and starts from the center diamond.
          Demo of passing config inline to start().
        </p>
        <button
          onClick={() =>
            useGameStore
              .getState()
              .diamondFXInstance?.start("demo-panel-half", false, true, {
                half: true,
              })
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
          <p className="text-white/60 text-xs mb-3">
            Config passed inline to start()
          </p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("blue-panel", false, true, {
                lineColor: "rgba(59, 130, 246, 0.95)",
              });
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
          <p className="text-white/60 text-xs mb-3">
            Config passed inline to start()
          </p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("green-panel", false, true, {
                lineColor: "rgba(34, 197, 94, 0.95)",
              });
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
          <p className="text-white/60 text-xs mb-3">
            Config passed inline to start()
          </p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("red-panel", false, true, {
                lineColor: "rgba(239, 68, 68, 0.95)",
              });
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
            No shadow, faster timings. Preset passed inline.
          </p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("low-panel", false, true, PERFORMANCE_PRESETS.low);
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
          <p className="text-white/60 text-xs mb-3">
            Balanced performance. Preset passed inline.
          </p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("mid-panel", false, true, PERFORMANCE_PRESETS.mid);
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
            Full effects, slower timings. Preset passed inline.
          </p>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("high-panel", false, true, PERFORMANCE_PRESETS.high);
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

  const switchTo = (targetId: string, refresh = true) => {
    useGameStore.getState().diamondFXInstance?.start(targetId, false, refresh);
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
    fx?.start("store-demo-panel", false, true);
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

export const AnimateOutDemo: Story = () => {
  const [started, setStarted] = useState(false);
  const [lastEvent, setLastEvent] = useState<string>("");
  const diamondFX = useGameStore((state) => state.diamondFXInstance);

  useEffect(() => {
    if (!diamondFX) return;

    const handleComplete = (exit: boolean) => {
      const label = exit ? "complete exit=true" : "complete exit=false";
      setLastEvent(label);
      console.log(`[AnimateOut] complete event exit=${exit}`);
    };

    diamondFX.on("complete", handleComplete);
    return () => {
      diamondFX.off("complete", handleComplete);
    };
  }, [diamondFX]);

  const startAnimation = () => {
    const fx = useGameStore.getState().diamondFXInstance;
    setStarted(true);
    setLastEvent("");
    fx?.start("animate-out-panel", false, true);
  };

  const fadeOut = () => {
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.clear(false);
    setStarted(false);
  };

  const animateOut = () => {
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.clear(true);
    setStarted(false);
  };

  const clearDuringAnimation = () => {
    // This will immediately clear even with animateOut=true because animation is playing
    const fx = useGameStore.getState().diamondFXInstance;
    fx?.clear(true);
    setStarted(false);
  };

  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.0 }} />

      <div
        id="animate-out-panel"
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[400px]"
      >
        <h2 className="text-white text-xl font-semibold mb-2">
          Animate Out Demo
        </h2>
        <p className="text-white/80 text-sm mb-4">
          Compare exit animations. The `complete` event carries an `exit`
          parameter: false when animating in, true when animating out.
        </p>
        {lastEvent && (
          <div className="mb-4 px-3 py-2 bg-green-900/30 border border-green-500/30 rounded text-green-300 text-xs font-mono">
            {lastEvent}
          </div>
        )}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={startAnimation}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
          >
            ▶ Start Animation
          </button>
          {started && (
            <>
              <button
                onClick={clearDuringAnimation}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm"
              >
                Clear (During)
              </button>
              <button
                onClick={fadeOut}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-sm"
              >
                Fade Out (Docked)
              </button>
              <button
                onClick={animateOut}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm"
              >
                ✨ Animate Out (Docked)
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

AnimateOutDemo.meta = {
  disconnectedStory: true,
};

export const EventListenersDemo: Story = () => {
  const [events, setEvents] = useState<string[]>([]);
  const [panelVisible, setPanelVisible] = useState(true);
  const diamondFX = useGameStore((state) => state.diamondFXInstance);

  useEffect(() => {
    if (!diamondFX) return;

    const recordEvent = (entry: string) =>
      setEvents((prev) => [entry, ...prev].slice(0, 12));

    const handlePhaseComplete = (phase: string) =>
      recordEvent(`phaseComplete → ${phase}`);
    const handleComplete = (exit: boolean) =>
      recordEvent(`complete → exit=${exit}`);
    const handleTargetRemoved = (targetId: string) =>
      recordEvent(`targetRemoved → ${targetId}`);

    diamondFX.on("phaseComplete", handlePhaseComplete);
    diamondFX.on("complete", handleComplete);
    diamondFX.on("targetRemoved", handleTargetRemoved);

    return () => {
      diamondFX.off("phaseComplete", handlePhaseComplete);
      diamondFX.off("complete", handleComplete);
      diamondFX.off("targetRemoved", handleTargetRemoved);
    };
  }, [diamondFX]);

  const startAnimation = () => {
    useGameStore
      .getState()
      .diamondFXInstance?.start("event-panel", false, true);
  };

  const clearAnimation = () => {
    useGameStore.getState().diamondFXInstance?.clear();
  };

  const animateOut = () => {
    useGameStore.getState().diamondFXInstance?.clear(true);
  };

  const toggleTarget = () => {
    setPanelVisible((prev) => {
      const next = !prev;
      setEvents((log) =>
        [
          next ? "target restored (DOM added)" : "target removed (DOM removed)",
          ...log,
        ].slice(0, 12)
      );
      return next;
    });
  };

  const clearEvents = () => setEvents([]);

  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.0 }} />

      <div className="absolute top-8 left-8 flex flex-col gap-4 max-w-sm">
        <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-5">
          <h2 className="text-white text-lg font-semibold mb-2">
            Event Listener Demo
          </h2>
          <p className="text-white/70 text-xs mb-4">
            Subscribe to the DiamondFX mitt emitter and react to animation
            phases, completion, and DOM removal events.
          </p>
          <div className="flex flex-wrap gap-2 text-sm">
            <button
              onClick={startAnimation}
              disabled={!panelVisible}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white"
            >
              ▶ Start
            </button>
            <button
              onClick={animateOut}
              className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white"
            >
              Animate Out
            </button>
            <button
              onClick={clearAnimation}
              className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-700 text-white"
            >
              Clear
            </button>
            <button
              onClick={toggleTarget}
              className="px-3 py-1.5 rounded bg-orange-600 hover:bg-orange-700 text-white"
            >
              {panelVisible ? "Remove Target" : "Restore Target"}
            </button>
            <button
              onClick={clearEvents}
              className="px-3 py-1.5 rounded bg-slate-600 hover:bg-slate-700 text-white"
            >
              Clear Log
            </button>
          </div>
        </div>

        <div className="bg-black/40 border border-white/10 rounded-xl p-4 max-h-72 overflow-y-auto">
          <div className="text-white/50 text-xs uppercase tracking-wide mb-2">
            Event Log
          </div>
          {events.length === 0 ? (
            <div className="text-white/40 text-xs">Waiting for events…</div>
          ) : (
            <ul className="space-y-1 text-xs font-mono text-white/80">
              {events.map((entry, index) => (
                <li key={`${entry}-${index}`}>{entry}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {panelVisible && (
        <div
          id="event-panel"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[360px]"
        >
          <h3 className="text-white text-xl font-semibold mb-2">
            Target Element
          </h3>
          <p className="text-white/70 text-sm">
            Launch the frame animation, then remove or restore this target to
            see the emitted events.
          </p>
        </div>
      )}
    </div>
  );
};

EventListenersDemo.meta = {
  disconnectedStory: true,
};

export const RefreshSameId: Story = () => {
  const [started, setStarted] = useState(false);

  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.0 }} />

      <div
        id="refresh-panel"
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[360px]"
      >
        <h2 className="text-white text-xl font-semibold mb-2">
          Refresh (Same ID)
        </h2>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("refresh-panel", false, true);
              setStarted(true);
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
          >
            ▶ Start
          </button>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("refresh-panel", false, true);
            }}
            disabled={!started}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm"
          >
            Refresh (Same ID)
          </button>
        </div>
      </div>
    </div>
  );
};

RefreshSameId.meta = {
  disconnectedStory: true,
};

export const RefreshDifferentId: Story = () => {
  const [started, setStarted] = useState(false);

  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.0 }} />

      <div
        id="refresh-diff-1"
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-6 min-w-[360px]"
      >
        <h2 className="text-white text-xl font-semibold mb-2">
          Refresh (Different ID)
        </h2>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("refresh-diff-1", false, true);
              setStarted(true);
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
          >
            ▶ Start on A
          </button>
          <button
            onClick={() => {
              const fx = useGameStore.getState().diamondFXInstance;
              fx?.start("refresh-diff-2", false, true);
            }}
            disabled={!started}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm"
          >
            Refresh to B (Different ID)
          </button>
        </div>
      </div>

      <div
        id="refresh-diff-2"
        className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-white/10 backdrop-blur-md border border-white/20 rounded-xl px-4 py-2"
      >
        <span className="text-white/80 text-xs">Target B</span>
      </div>
    </div>
  );
};

RefreshDifferentId.meta = {
  disconnectedStory: true,
};

export const InlineConfigDemo: Story = () => {
  return (
    <div className="relative w-full h-screen bg-black">
      <AnimatedFrame config={{ shadowBlur: 1.0 }} />

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-6">
        <div className="text-center mb-2">
          <h2 className="text-white text-2xl font-bold mb-2">
            Inline Config Demo
          </h2>
          <p className="text-white/70 text-sm">
            Pass config directly to start() without calling update() first
          </p>
        </div>

        <div className="flex gap-6">
          <div
            id="fast-panel"
            className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-5 min-w-[220px]"
          >
            <h3 className="text-white text-lg font-semibold mb-2">Fast</h3>
            <p className="text-white/60 text-xs mb-4">
              Quick animation with reduced timings
            </p>
            <button
              onClick={() => {
                const fx = useGameStore.getState().diamondFXInstance;
                fx?.start("fast-panel", false, true, {
                  timings: {
                    in: 200,
                    morph: 150,
                    blink: 150,
                    spin: 0,
                    split: 150,
                  },
                  shadowBlur: 0.5,
                });
              }}
              className="w-full px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-sm"
            >
              ▶ Fast Animation
            </button>
          </div>

          <div
            id="dramatic-panel"
            className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-5 min-w-[220px]"
          >
            <h3 className="text-white text-lg font-semibold mb-2">Dramatic</h3>
            <p className="text-white/60 text-xs mb-4">
              Slow with spin and high glow
            </p>
            <button
              onClick={() => {
                const fx = useGameStore.getState().diamondFXInstance;
                fx?.start("dramatic-panel", false, true, {
                  timings: {
                    in: 600,
                    morph: 400,
                    blink: 400,
                    spin: 800,
                    split: 400,
                  },
                  shadowBlur: 2.0,
                  lineColor: "rgba(255, 215, 0, 0.95)",
                });
              }}
              className="w-full px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg text-sm"
            >
              ▶ Dramatic Animation
            </button>
          </div>

          <div
            id="minimal-panel"
            className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-5 min-w-[220px]"
          >
            <h3 className="text-white text-lg font-semibold mb-2">Minimal</h3>
            <p className="text-white/60 text-xs mb-4">
              Half mode, no spin, subtle
            </p>
            <button
              onClick={() => {
                const fx = useGameStore.getState().diamondFXInstance;
                fx?.start("minimal-panel", false, true, {
                  half: true,
                  timings: {
                    in: 0,
                    morph: 250,
                    blink: 200,
                    spin: 0,
                    split: 200,
                  },
                  shadowBlur: 0,
                  lineColor: "rgba(200, 200, 200, 0.6)",
                });
              }}
              className="w-full px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg text-sm"
            >
              ▶ Minimal Animation
            </button>
          </div>
        </div>

        <div className="bg-blue-900/20 backdrop-blur-md border border-blue-500/30 rounded-xl p-4 text-center">
          <p className="text-blue-200 text-sm">
            💡 Tip: Each button passes a different config object directly to{" "}
            <code className="bg-black/30 px-1 rounded">start()</code> method
          </p>
        </div>
      </div>
    </div>
  );
};

InlineConfigDemo.meta = {
  disconnectedStory: true,
};
