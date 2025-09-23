import React, { useEffect, useMemo, useState } from "react";

import HudMapVisualization from "./components/HudMapVisualization";
import useSectorStore from "./stores/sector";
import useLocalMapStore, {
  type LocalMapPayload,
} from "./stores/localMap";

const MOCK_MAP: LocalMapPayload = {
  character_id: "DebugPilot",
  sector: 3330,
  max_sectors: 15,
  node_list: [
    { id: 3330, visited: true, port_type: "SBB", adjacent: [3331, 3329] },
    { id: 3331, visited: true, port_type: null, adjacent: [3330, 3332] },
    { id: 3329, visited: false, port_type: null, adjacent: [3330] },
    { id: 3332, visited: false, port_type: null, adjacent: [3331] },
  ],
};

export const HudMapDebugHarness: React.FC = () => {
  const [initialized, setInitialized] = useState(false);
  const setLocalMap = useLocalMapStore((state) => state.setLocalMap);

  useEffect(() => {
    useSectorStore.setState({ sector: MOCK_MAP.sector });
    setLocalMap(MOCK_MAP);
    setInitialized(true);
  }, [setLocalMap]);

  const summary = useMemo(() => {
    const nodes = MOCK_MAP.node_list ?? [];
    return `${nodes.length} node${nodes.length === 1 ? "" : "s"} • sector ${MOCK_MAP.sector}`;
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-900 text-white">
      <div className="max-w-5xl mx-auto py-12 px-8 space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">HudMapVisualization Debug</h1>
          <p className="text-sm text-slate-300">
            Rendering static data: {summary}. Resize the viewport or edit <code>MOCK_MAP</code> in
            <code>HudMapDebugHarness.tsx</code> to experiment with layouts.
          </p>
          {!initialized ? (
            <p className="text-xs text-amber-300">
              Initializing Zustand stores… if this message persists, check the harness initialization.
            </p>
          ) : null}
        </header>

        <section className="relative w-full h-[540px] border border-slate-700 rounded-xl overflow-hidden bg-black/70">
          <HudMapVisualization />
        </section>
      </div>
    </div>
  );
};

export default HudMapDebugHarness;
