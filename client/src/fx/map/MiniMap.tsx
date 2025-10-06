// Slim render config, removing unused global-style fields like current_region/show_regions
export interface MiniMapRenderConfig {
  current_sector_id: number;
  colors: {
    empty: string;
    port: string;
    mega_port: string;
    visited: string;
    lane: string;
    hyperlane: string;
    lane_one_way: string;
    sector_border: string;
    sector_border_current: string;
    cross_region_outline: string;
    sector_id_text: string;
    grid: string;
    background: string;
  };
  grid_spacing?: number; // Distance between hex centers in pixels (default: auto-calculated)
  hex_size?: number; // Visual radius of each hex in pixels (default: grid_spacing * 0.85)
  show_grid: boolean;
  show_warps: boolean;
  show_sector_ids: boolean;
  show_ports: boolean;
  show_hyperlanes: boolean;
}

// Suggested optimized data structures for MiniMap rendering
// These align closely with server data while optimizing lookup and traversal.
export interface MiniMapNode {
  id: number;
  position: [number, number]; // axial hex coords (q, r)
  visited?: boolean;
  port?: string; // truthy indicates a port; string can be code/type
  region?: string; // region identifier for cross-region lane styling
  lanes: MiniMapLane[]; // lanes originating from this node
}

export interface MiniMapLane {
  from: number;
  to: number;
  two_way: boolean;
  hyperlane?: boolean;
}

export type MiniMapData = Record<number, MiniMapNode>; // id -> node (lanes embedded per node)

export interface MiniMapProps {
  width: number;
  height: number;
  data: MiniMapData;
  config: MiniMapRenderConfig;
  maxDistance?: number; // BFS depth from current sector
}

// Utility: build adjacency from edges for quick BFS traversals
export function buildAdjacency(data: MiniMapData): Map<number, number[]> {
  const adjacency = new Map<number, number[]>();
  const push = (a: number, b: number) => {
    const arr = adjacency.get(a);
    if (arr) arr.push(b);
    else adjacency.set(a, [b]);
  };
  Object.values(data).forEach((node) => {
    if (!node.lanes) return;
    for (const e of node.lanes) {
      push(node.id, e.to);
      if (e.two_way) push(e.to, node.id);
    }
  });
  return adjacency;
}

// Utility: BFS limited by depth from a start node id
export function bfsWithinDistance(
  startId: number,
  maxDistance: number,
  adjacency: Map<number, number[]>
): Map<number, number> {
  const distanceById = new Map<number, number>();
  const queue: { id: number; d: number }[] = [];
  distanceById.set(startId, 0);
  queue.push({ id: startId, d: 0 });
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (d >= maxDistance) continue;
    const neighbors = adjacency.get(id) || [];
    for (const n of neighbors) {
      if (!distanceById.has(n)) {
        distanceById.set(n, d + 1);
        queue.push({ id: n, d: d + 1 });
      }
    }
  }
  return distanceById;
}

// Utility: transform MapSectorNode[] into MiniMapData
export function mapSectorNodesToMiniMapData(
  nodes: MapSectorNode[],
  regionBySectorId?: Record<number, string>
): MiniMapData {
  const outNodes: Record<number, MiniMapNode> = {};
  for (const n of nodes) {
    outNodes[n.id] = {
      id: n.id,
      position: n.position,
      visited: Boolean(n.visited || n.last_visited),
      port: n.port,
      region: regionBySectorId ? regionBySectorId[n.id] : undefined,
      lanes: (n.lanes || []).map((l) => ({
        from: n.id,
        to: l.to,
        two_way: l.two_way,
        hyperlane: l.hyperlane,
      })),
    };
  }
  return outNodes;
}

// Convert hex grid coordinates to world pixels (flat-top hexes, offset coordinates)
// hexX, hexY are offset/grid coordinates (not axial)
// gridSpacing is the actual distance between hex centers in pixels
export function hexToPixel(
  hexX: number,
  hexY: number,
  gridSpacing: number
): { x: number; y: number } {
  const x = gridSpacing * hexX;
  const y = ((gridSpacing * Math.sqrt(3)) / 2) * (hexY * 2 + (hexX & 1));
  return { x, y };
}

// Draw a hex outline at (x, y) center (flat-top orientation)
export function drawHex(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  fillStyle?: string,
  strokeStyle?: string
) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i; // flat-top (no offset)
    const px = x + size * Math.cos(angle);
    const py = y + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
  }
}

export function renderMiniMapCanvas(
  canvas: HTMLCanvasElement,
  props: MiniMapProps
) {
  const { width, height, data, config, maxDistance = 3 } = props;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = config.colors.background;
  ctx.fillRect(0, 0, width, height);

  // Build traversal state
  const adjacency = buildAdjacency(data);
  const distanceById = bfsWithinDistance(
    config.current_sector_id,
    maxDistance,
    adjacency
  );

  // Determine the nodes to render (include current node even if isolated)
  const visibleIds = new Set<number>([config.current_sector_id]);
  for (const id of distanceById.keys()) visibleIds.add(id);

  // Centered layout: place current sector at canvas center
  // Calculate grid spacing (distance between hex centers)
  const defaultGridSpacing = Math.max(20, Math.min(width, height) / 10);
  const gridSpacing =
    config.grid_spacing &&
    Number.isFinite(config.grid_spacing) &&
    config.grid_spacing > 0
      ? Math.max(10, Math.min(300, config.grid_spacing))
      : defaultGridSpacing;

  // Calculate hex visual radius (size of drawn hexes)
  // Default to 85% of grid spacing to create nice gaps
  const hexRadius =
    config.hex_size && Number.isFinite(config.hex_size) && config.hex_size > 0
      ? Math.max(4, Math.min(gridSpacing, config.hex_size))
      : gridSpacing * 0.85;

  const currentNode = data[config.current_sector_id];
  if (!currentNode) return;
  const currentWorld = hexToPixel(
    currentNode.position[0],
    currentNode.position[1],
    gridSpacing
  );
  const transformPoint = (x: number, y: number) => ({
    x: x - currentWorld.x + width / 2,
    y: y - currentWorld.y + height / 2,
  });

  // Grid background: tile hex outlines around current sector
  if (config.show_grid) {
    ctx.strokeStyle = config.colors.grid;
    ctx.lineWidth = 1;
    const q0 = currentNode.position[0];
    const r0 = currentNode.position[1];
    const range = Math.ceil(Math.max(width, height) / gridSpacing) + 2;
    for (let dq = -range; dq <= range; dq++) {
      for (let dr = -range; dr <= range; dr++) {
        const q = q0 + dq;
        const r = r0 + dr;
        const w = hexToPixel(q, r, gridSpacing);
        const t = transformPoint(w.x, w.y);
        if (
          t.x < -gridSpacing ||
          t.x > width + gridSpacing ||
          t.y < -gridSpacing ||
          t.y > height + gridSpacing
        )
          continue;
        drawHex(ctx, t.x, t.y, hexRadius, undefined, config.colors.grid);
      }
    }
  }

  // Draw lanes first (behind nodes)
  if (config.show_warps) {
    const drawArrowHead = (
      ctx2: CanvasRenderingContext2D,
      from: { x: number; y: number },
      to: { x: number; y: number },
      color: string
    ) => {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const size = Math.max(4, Math.min(10, hexRadius * 0.6));
      const ax = to.x - size * Math.cos(angle);
      const ay = to.y - size * Math.sin(angle);
      ctx2.save();
      ctx2.fillStyle = color;
      ctx2.beginPath();
      ctx2.moveTo(to.x, to.y);
      ctx2.lineTo(
        ax - size * 0.6 * Math.cos(angle - Math.PI / 2),
        ay - size * 0.6 * Math.sin(angle - Math.PI / 2)
      );
      ctx2.lineTo(
        ax + size * 0.6 * Math.cos(angle - Math.PI / 2),
        ay + size * 0.6 * Math.sin(angle - Math.PI / 2)
      );
      ctx2.closePath();
      ctx2.fill();
      ctx2.restore();
    };

    const drawn = new Set<string>();
    Object.values(data).forEach((a) => {
      if (!a.lanes || !visibleIds.has(a.id)) return;
      const pa = transformPoint(
        ...(Object.values(
          hexToPixel(a.position[0], a.position[1], gridSpacing)
        ) as [number, number])
      );
      for (const e of a.lanes) {
        if (!visibleIds.has(e.to)) continue;
        const b = data[e.to];
        if (!b) continue;
        const pb = transformPoint(
          ...(Object.values(
            hexToPixel(b.position[0], b.position[1], gridSpacing)
          ) as [number, number])
        );
        const isReachable = distanceById.has(a.id) && distanceById.has(e.to);

        let strokeColor: string;
        if (e.hyperlane && config.show_hyperlanes) {
          strokeColor = e.two_way
            ? config.colors.hyperlane
            : config.colors.lane_one_way;
          ctx.strokeStyle = strokeColor;
          ctx.setLineDash([12, 7]);
          ctx.lineWidth = 3;
        } else {
          strokeColor = e.two_way
            ? config.colors.lane
            : config.colors.lane_one_way;
          ctx.strokeStyle = strokeColor;
          ctx.setLineDash([]);
          ctx.lineWidth = isReachable ? 3 : 1.75;
        }

        if (e.two_way) {
          const key = `${Math.min(a.id, e.to)}-${Math.max(a.id, e.to)}-${
            e.hyperlane ? 1 : 0
          }`;
          if (drawn.has(key)) continue;
          drawn.add(key);
        }

        ctx.save();
        ctx.globalAlpha = isReachable ? 1 : 0.5;
        // Trim to hex edges (trim by hex visual radius)
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len = Math.max(1e-3, Math.hypot(dx, dy));
        const off = hexRadius;
        const sx = pa.x + (dx / len) * off;
        const sy = pa.y + (dy / len) * off;
        const ex = pb.x - (dx / len) * off;
        const ey = pb.y - (dy / len) * off;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        if (!e.two_way) {
          drawArrowHead(ctx, { x: sx, y: sy }, { x: ex, y: ey }, strokeColor);
        }
        ctx.restore();
      }
    });
  }

  // Draw nodes
  for (const id of visibleIds) {
    const node = data[id];
    if (!node) continue;
    const p = hexToPixel(node.position[0], node.position[1], gridSpacing);
    const t = transformPoint(p.x, p.y);
    const isCurrent = id === config.current_sector_id;
    const isVisited = !!node.visited;
    const hasPort = !!node.port;
    const currentRegion = data[config.current_sector_id]?.region;
    const crossRegionVsCurrent = Boolean(
      currentRegion && node.region && node.region !== currentRegion
    );

    const fill = isVisited ? config.colors.visited : config.colors.empty;
    drawHex(
      ctx,
      t.x,
      t.y,
      hexRadius,
      fill,
      isCurrent
        ? config.colors.sector_border_current
        : config.colors.sector_border
    );

    // Add a distinct outline if this sector is in a different region than current
    if (crossRegionVsCurrent) {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = config.colors.cross_region_outline;
      drawHex(
        ctx,
        t.x,
        t.y,
        hexRadius + 2,
        undefined,
        config.colors.cross_region_outline
      );
      ctx.restore();
    }

    if (config.show_ports && hasPort) {
      const isMega = node.port === "MEGA";
      ctx.fillStyle = isMega ? config.colors.mega_port : config.colors.port;
      ctx.beginPath();
      ctx.arc(t.x, t.y, Math.max(3, hexRadius * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }

    if (config.show_sector_ids) {
      ctx.fillStyle = config.colors.sector_id_text;
      ctx.font = `${Math.max(9, Math.floor(hexRadius * 0.8))}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText(String(id), t.x, t.y + 3);
    }
  }
}
