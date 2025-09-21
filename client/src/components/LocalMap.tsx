import React, { useMemo } from "react";

type Node = {
  id: number;
  visited: boolean;
  port_type?: string | null;
  adjacent: number[];
};

type Props = {
  nodes: Node[];
  centerId: number;
  maxHops?: number; // purely for ring rendering if provided
  width?: number;
  height?: number;
};

// Build undirected neighbor sets from directed adjacency (for hop rings only)
function buildUndirected(nodes: Node[]): Map<number, Set<number>> {
  const undirected = new Map<number, Set<number>>();
  const add = (a: number, b: number) => {
    if (!undirected.has(a)) undirected.set(a, new Set());
    undirected.get(a)!.add(b);
  };
  const idSet = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (!undirected.has(n.id)) undirected.set(n.id, new Set());
    for (const t of n.adjacent) {
      if (!idSet.has(t)) continue; // ignore edges outside subgraph
      add(n.id, t);
      add(t, n.id);
    }
  }
  return undirected;
}

function bfsRings(
  center: number,
  undirected: Map<number, Set<number>>
): Map<number, number> {
  const dist = new Map<number, number>();
  const q: number[] = [];
  dist.set(center, 0);
  q.push(center);
  while (q.length) {
    const cur = q.shift()!;
    const d = dist.get(cur)!;
    for (const nb of undirected.get(cur) ?? []) {
      if (!dist.has(nb)) {
        dist.set(nb, d + 1);
        q.push(nb);
      }
    }
  }
  return dist;
}

export const LocalMap: React.FC<Props> = ({
  nodes,
  centerId,
  width = 640,
  height = 480,
}) => {
  const { positionedNodes, edgePairs, maxRing } = useMemo(() => {
    const undirected = buildUndirected(nodes);
    if (!undirected.has(centerId)) undirected.set(centerId, new Set());
    const dist = bfsRings(centerId, undirected);

    // Group ids by ring
    const rings: Map<number, number[]> = new Map();
    for (const n of nodes) {
      if (!dist.has(n.id)) continue; // disconnected nodes are ignored
      const d = dist.get(n.id)!;
      if (!rings.has(d)) rings.set(d, []);
      rings.get(d)!.push(n.id);
    }

    // Place nodes around concentric circles
    const cx = width / 2;
    const cy = height / 2;
    const ringSpacing = Math.min(width, height) / (2 * Math.max(3, rings.size + 1));
    const pos = new Map<number, { x: number; y: number; ring: number }>();
    const maxRing = Math.max(...Array.from(rings.keys()));

    for (const [k, ids] of Array.from(rings.entries()).sort((a, b) => a[0] - b[0])) {
      if (k === 0) {
        pos.set(centerId, { x: cx, y: cy, ring: 0 });
        continue;
      }
      const r = ringSpacing * k;
      const count = ids.length;
      for (let i = 0; i < count; i++) {
        const theta = (2 * Math.PI * i) / count;
        pos.set(ids[i], { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta), ring: k });
      }
    }

    // Build undirected edge pairs for arrowheads (single stroke, 1 or 2 arrows)
    const idToNode = new Map(nodes.map((n) => [n.id, n] as const));
    const pairs = new Map<string, {
      a: number; b: number; hasAB: boolean; hasBA: boolean;
    }>();
    for (const n of nodes) {
      for (const t of n.adjacent) {
        if (!idToNode.has(t)) continue;
        const [a, b] = n.id < t ? [n.id, t] : [t, n.id];
        const key = `${a}-${b}`;
        const rec = pairs.get(key) ?? { a, b, hasAB: false, hasBA: false };
        if (n.id === a) rec.hasAB = true; else rec.hasBA = true;
        pairs.set(key, rec);
      }
    }

    const positionedNodes = nodes
      .filter((n) => pos.has(n.id))
      .map((n) => ({ ...n, ...pos.get(n.id)! }));

    return { positionedNodes, edgePairs: Array.from(pairs.values()), maxRing };
  }, [nodes, centerId, width, height]);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <marker id="arrow-end" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#9aa0a6" />
        </marker>
      </defs>

      {/* rings */}
      {Array.from({ length: maxRing }).map((_, idx) => {
        const r = (Math.min(width, height) / (2 * Math.max(3, maxRing + 1))) * (idx + 1);
        return (
          <circle key={idx} cx={width / 2} cy={height / 2} r={r} fill="none" stroke="#2b2b2b" strokeDasharray="4 4" />
        );
      })}

      {/* edges */}
      {edgePairs.map((e) => {
        const a = positionedNodes.find((n) => n.id === e.a);
        const b = positionedNodes.find((n) => n.id === e.b);
        if (!a || !b) return null;
        const markerStart = e.hasBA ? "url(#arrow-end)" : undefined;
        const markerEnd = e.hasAB ? "url(#arrow-end)" : undefined;
        return (
          <line
            key={`${e.a}-${e.b}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="#9aa0a6"
            strokeWidth={1.25}
            markerStart={markerStart}
            markerEnd={markerEnd}
            opacity={0.9}
          />
        );
      })}

      {/* nodes */}
      {positionedNodes.map((n) => (
        <g key={n.id}>
          <circle
            cx={n.x}
            cy={n.y}
            r={10}
            fill={n.id === centerId ? "#ffd54f" : n.visited ? "#b0bec5" : "#ef9a9a"}
            stroke="#1f1f1f"
            strokeWidth={1}
          />
          <text x={n.x} y={n.y - 14} textAnchor="middle" fontSize="10" fill="#e0e0e0">
            {n.id}
          </text>
          {n.port_type && (
            <text x={n.x} y={n.y + 18} textAnchor="middle" fontSize="9" fill="#9ccc65">
              {n.port_type}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
};

export default LocalMap;

