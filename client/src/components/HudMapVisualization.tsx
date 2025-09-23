import { usePipecatClient } from "@pipecat-ai/client-react";
import cytoscape, { type Core as CytoscapeInstance } from "cytoscape";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import useSectorStore from "../stores/sector";
import useLocalMapStore, {
  type LocalMapNode,
  type LocalMapPayload,
} from "../stores/localMap";
import GraphLayout from "../utils/GraphLayout";

const MAX_SECTORS = 12;

interface LayoutCacheEntry {
  signature: string;
  positions: Record<string, { x: number; y: number }>;
}

const cacheKeyFor = (sector: number, limit: number) => `${sector}:${limit}`;

const normalizeNodes = (nodes: LocalMapNode[]): LocalMapNode[] =>
  nodes.map((node) => ({
    ...node,
    adjacent: [...node.adjacent].sort((a, b) => a - b),
  }));

const signatureFor = (nodes: LocalMapNode[]) =>
  JSON.stringify(
    normalizeNodes(nodes).sort((a, b) => a.id - b.id)
  );

const layoutKeyForNodes = (nodes: LocalMapNode[]): string =>
  [...nodes]
    .map((node) => ({ id: Number(node.id), visited: Boolean(node.visited) }))
    .sort((a, b) => a.id - b.id)
    .map((item) => `${item.id}:${item.visited ? "t" : "f"}`)
    .join(",");

export const HudMapVisualization: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<CytoscapeInstance | null>(null);
  const layoutCacheRef = useRef<Map<string, LayoutCacheEntry>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());

  const client = usePipecatClient();
  const sector = useSectorStore((state) => state.sector);
  const localMapEntry = useLocalMapStore(
    useCallback(
      (state) =>
        typeof sector === "number"
          ? state.getLocalMap(sector, MAX_SECTORS)
          : undefined,
      [sector]
    )
  );

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const ensureRequest = useCallback(
    (targetSector: number) => {
      console.log("[HudMapVisualization] ensureRequest", { targetSector, clientPresent: !!client });
      if (!client) {
        return;
      }
      const key = cacheKeyFor(targetSector, MAX_SECTORS);
      if (inFlightRef.current.has(key)) {
        console.log("[HudMapVisualization] request already in-flight", { key });
        return;
      }

      inFlightRef.current.add(key);
      console.log("[HudMapVisualization] sending RTVI request", { key });
      setStatus("loading");
      setErrorMessage(null);

      client.sendClientMessage("get-local-map", {
        sector: targetSector,
        max_sectors: MAX_SECTORS,
      });
    },
    [client]
  );

  const renderWithPositions = useCallback(
    (nodes: LocalMapNode[], center: number, positions: LayoutCacheEntry["positions"]) => {
      if (!containerRef.current) {
        return;
      }

      console.log("[HudMapVisualization] renderWithPositions", {
        nodes: nodes.length,
        center,
        havePositions: Object.keys(positions ?? {}).length,
      });

      const elements = GraphLayout.createElements(nodes, center);
      console.log("[HudMapVisualization] elements payload", {
        center,
        nodeCount: nodes.length,
        elementSample: elements.slice(0, 5),
      });
      elements.forEach((element) => {
        if (!element.data.source && !element.data.target) {
          const id = String(element.data.id);
          const pos = positions[id];
          if (pos) {
            element.position = pos;
          }
        }
      });

      const cy = cytoscape({
        container: containerRef.current,
        elements,
        style: GraphLayout.getDefaultStyles(),
        userZoomingEnabled: true,
        userPanningEnabled: true,
        autoungrabify: false,
        layout: { name: "preset" },
      });

      cy.resize();
      cy.fit(undefined, 24);

      const rect = containerRef.current.getBoundingClientRect();
      console.log("[HudMapVisualization] renderWithPositions container rect", rect);
      const computedCached = window.getComputedStyle(containerRef.current);
      console.log("[HudMapVisualization] renderWithPositions container style", {
        width: computedCached.width,
        height: computedCached.height,
        overflow: computedCached.overflow,
        position: computedCached.position,
      });

      console.log("[HudMapVisualization] cy created (cached)", {
        nodeIds: cy.nodes().map((n) => n.id()),
        classes: cy.nodes().map((n) => n.classes()),
        positions: cy.nodes().map((n) => n.position()),
        renderedPositions: cy.nodes().map((n) => n.renderedPosition()),
      });

      if (typeof window !== "undefined") {
        (window as any).cy = cy;
        (window as any).cyDebug = {
          cy,
          nodes: cy.nodes().map((n) => ({
            id: n.id(),
            position: n.position(),
            renderedPosition: n.renderedPosition(),
            boundingBox: n.boundingBox(),
            style: {
              width: n.style("width"),
              height: n.style("height"),
              backgroundColor: n.style("background-color"),
            },
          })),
        };
        console.log("[HudMapVisualization] attached window.cy", { nodeCount: cy.nodes().length });
      }

      cyRef.current = cy;
    },
    []
  );

  const renderGraph = useCallback(
    async (payload: LocalMapPayload, signature: string) => {
      const layoutKey = layoutKeyForNodes(payload.node_list ?? []);

      console.log("[HudMapVisualization] renderGraph", {
        sector: payload.sector,
        nodes: payload.node_list?.length ?? 0,
        signature,
        layoutKey,
      });
      if (!payload.node_list || payload.node_list.length === 0) {
        if (cyRef.current) {
          cyRef.current.destroy();
          cyRef.current = null;
          console.log("[HudMapVisualization] destroyed existing graph (no nodes)");
        }
        return;
      }

      if (!containerRef.current) {
        console.log("[HudMapVisualization] aborting render: no container");
        return;
      }

      const cached = layoutCacheRef.current.get(layoutKey);

      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
        console.log("[HudMapVisualization] destroyed previous Cytoscape instance");
      }

      if (cached && cached.signature === signature) {
        renderWithPositions(payload.node_list, payload.sector, cached.positions);
        setStatus("idle");
        setErrorMessage(null);
        return;
      }

      const cy = await GraphLayout.renderOptimized(payload.node_list, payload.sector, {
        container: containerRef.current,
        minNodeDist: 4,
        nodeRepulsion: 16000,
      });

      cy.resize();
      cy.fit(undefined, 24);

      const rect = containerRef.current.getBoundingClientRect();
      const computed = window.getComputedStyle(containerRef.current);
      console.log("[HudMapVisualization] renderGraph container rect", rect);
      console.log("[HudMapVisualization] renderGraph container style", {
        width: computed.width,
        height: computed.height,
        overflow: computed.overflow,
        position: computed.position,
      });

      console.log("[HudMapVisualization] cy created (layout)", {
        nodeIds: cy.nodes().map((n) => n.id()),
        classes: cy.nodes().map((n) => n.classes()),
        positions: cy.nodes().map((n) => n.position()),
        renderedPositions: cy.nodes().map((n) => n.renderedPosition()),
      });

      if (typeof window !== "undefined") {
        (window as any).cy = cy;
        (window as any).cyDebug = {
          cy,
          nodes: cy.nodes().map((n) => ({
            id: n.id(),
            position: n.position(),
            renderedPosition: n.renderedPosition(),
            boundingBox: n.boundingBox(),
            style: {
              width: n.style("width"),
              height: n.style("height"),
              backgroundColor: n.style("background-color"),
            },
          })),
        };
        console.log("[HudMapVisualization] attached window.cy after layout", { nodeCount: cy.nodes().length });
      }

      const positions: LayoutCacheEntry["positions"] = {};
      cy.nodes().forEach((node) => {
        positions[node.id()] = node.position();
      });

      layoutCacheRef.current.set(layoutKey, { signature, positions });
      cyRef.current = cy;
      setStatus("idle");
      console.log("[HudMapVisualization] stored layout cache", { layoutKey, signature });
    },
    [renderWithPositions]
  );

  useEffect(() => {
    if (typeof sector !== "number") {
      console.log("[HudMapVisualization] sector undefined; skipping request");
      return;
    }
    console.log("[HudMapVisualization] sector changed", { sector });
    ensureRequest(sector);
  }, [sector, ensureRequest]);

  useEffect(() => {
    if (!localMapEntry || typeof localMapEntry.sector !== "number") {
      console.log("[HudMapVisualization] no localMapEntry yet", { localMapEntry });
      return;
    }

    const entryLimit =
      typeof localMapEntry.max_sectors === "number"
        ? localMapEntry.max_sectors
        : typeof localMapEntry.max_hops === "number"
        ? localMapEntry.max_hops
        : MAX_SECTORS;

    const requestKey = cacheKeyFor(localMapEntry.sector, entryLimit);
    inFlightRef.current.delete(requestKey);
    console.log("[HudMapVisualization] received local map", {
      requestKey,
      nodes: localMapEntry.node_list?.length ?? 0,
      max_sectors: localMapEntry.max_sectors,
      max_hops: localMapEntry.max_hops,
      error: localMapEntry.error,
    });

    if (localMapEntry.error) {
      setStatus("error");
      setErrorMessage(localMapEntry.error);
      console.log("[HudMapVisualization] local map error", localMapEntry.error);
      return;
    }

    const nodes = localMapEntry.node_list ?? [];
    if (nodes.length === 0) {
      setStatus("idle");
      setErrorMessage(null);
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
        console.log("[HudMapVisualization] cleared graph (empty node list)");
      }
      return;
    }

    const signature = signatureFor(nodes);
    void renderGraph(localMapEntry, signature).catch((error) => {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : String(error));
      console.error("[HudMapVisualization] renderGraph failed", error);
    });
  }, [localMapEntry, renderGraph]);

  useEffect(
    () => () => {
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    },
    []
  );

  const nodeCount = localMapEntry?.node_list?.length ?? 0;

  return (
    <div
      className="w-full h-full relative overflow-hidden rounded-lg bg-black/40 backdrop-blur-sm border border-white/10"
      data-hud-map-root
    >
      <div ref={containerRef} className="hud-map-canvas" />
      <div className="absolute top-2 right-2 text-xs text-white/70 bg-black/60 px-2 py-1 rounded">
        {typeof sector === "number" ? `Sector ${sector}` : "Sector --"}
      </div>
      {status === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center text-white/70 text-xs bg-black/30">
          Loading local map…
        </div>
      ) : null}
      {status === "error" && errorMessage ? (
        <div className="absolute inset-x-0 bottom-0 m-2 text-amber-200 text-xs bg-amber-800/70 px-2 py-1 rounded">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
};

export default HudMapVisualization;
