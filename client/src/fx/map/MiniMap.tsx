export interface MiniMapConfigBase {
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
    label: string;
    label_bg: string;
    grid: string;
    background: string;
    current: string;
    current_outline: string;
  };
  grid_spacing: number;
  hex_size: number;
  sector_label_offset: number;
  frame_padding: number;
  edge_feather_size?: number;
  current_sector_outer_border: number;
  animation_duration_pan: number;
  animation_duration_zoom: number;
  bypass_animation: boolean;
  debug: boolean;
  show_grid: boolean;
  show_warps: boolean;
  show_sector_ids: boolean;
  show_ports: boolean;
  show_hyperlanes: boolean;
}

export const DEFAULT_MINIMAP_CONFIG: Omit<
  MiniMapConfigBase,
  "current_sector_id"
> = {
  colors: {
    empty: "rgba(0,0,0,0.35)",
    visited: "rgba(0,255,0,0.25)",
    port: "#4a90e2",
    mega_port: "#ffd700",
    lane: "rgba(120,230,160,1)",
    hyperlane: "rgba(190,160,255,1)",
    lane_one_way: "#4a90e2",
    sector_border: "rgba(200,200,200,0.7)",
    sector_border_current: "#4a90e2",
    cross_region_outline: "rgba(255,120,120,0.9)",
    sector_id_text: "#dddddd",
    grid: "rgba(255,255,255,0.3)",
    background: "#000000",
    label: "#000000",
    label_bg: "#ffffff",
    current: "#4a90e2",
    current_outline: "rgba(74,144,226,0.6)",
  },
  grid_spacing: 30,
  hex_size: 20,
  sector_label_offset: 5,
  frame_padding: 40,
  edge_feather_size: 220,
  current_sector_outer_border: 5,
  animation_duration_pan: 500,
  animation_duration_zoom: 800,
  bypass_animation: false,
  debug: false,
  show_grid: true,
  show_warps: true,
  show_sector_ids: true,
  show_ports: true,
  show_hyperlanes: true,
};

export interface MiniMapProps {
  width: number;
  height: number;
  data: MapData;
  config: MiniMapConfigBase;
  maxDistance?: number;
}

export interface CameraState {
  offsetX: number;
  offsetY: number;
  zoom: number;
  filteredData: MapData;
  fadingOutData?: MapData;
  fadingInData?: MapData;
  fadeProgress?: number;
}

interface AnimationState {
  isAnimating: boolean;
  startTime: number;
  panDuration: number;
  zoomDuration: number;
  fadeDuration: number;
  startCamera: CameraState;
  targetCamera: CameraState;
  animationFrameId?: number;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Find sector by ID in array */
function findSector(
  data: MapData,
  sectorId: number
): MapSectorNode | undefined {
  return data.find((s) => s.id === sectorId);
}

function interpolateCameraState(
  start: CameraState,
  target: CameraState,
  panProgress: number,
  zoomProgress: number,
  fadeProgress: number
): CameraState {
  const easedPan = easeInOutCubic(panProgress);
  const easedZoom = easeInOutCubic(zoomProgress);
  return {
    offsetX: start.offsetX + (target.offsetX - start.offsetX) * easedPan,
    offsetY: start.offsetY + (target.offsetY - start.offsetY) * easedPan,
    zoom: start.zoom + (target.zoom - start.zoom) * easedZoom,
    filteredData: start.filteredData,
    fadingOutData: start.fadingOutData,
    fadingInData: start.fadingInData,
    fadeProgress,
  };
}

function hexToWorld(
  hexX: number,
  hexY: number,
  scale: number
): { x: number; y: number } {
  const x = scale * 1.5 * hexX;
  const y = scale * Math.sqrt(3) * (hexY + 0.5 * (hexX & 1));
  return { x, y };
}

function drawHex(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  fill = false
) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const px = x + size * Math.cos(angle);
    const py = y + size * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  if (fill) ctx.fill();
  ctx.stroke();
}

/** BFS traversal to find all sectors reachable within maxDistance jumps */
function calculateReachableSectors(
  data: MapData,
  currentSectorId: number,
  maxDistance: number
): Map<number, number> {
  const reachableMap = new Map<number, number>();
  const currentSector = findSector(data, currentSectorId);
  if (!currentSector) return reachableMap;

  const queue: Array<{ id: number; distance: number }> = [
    { id: currentSectorId, distance: 0 },
  ];
  const visited = new Set<number>([currentSectorId]);
  reachableMap.set(currentSectorId, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.distance >= maxDistance) continue;

    const sector = findSector(data, current.id);
    if (!sector) continue;

    sector.lanes.forEach((lane) => {
      if (!visited.has(lane.to)) {
        visited.add(lane.to);
        reachableMap.set(lane.to, current.distance + 1);
        queue.push({ id: lane.to, distance: current.distance + 1 });
      }
    });
  }

  return reachableMap;
}

/** Filter to only sectors in the reachable map */
function filterReachableSectors(
  data: MapData,
  reachableMap: Map<number, number>
): MapData {
  return data.filter((sector) => reachableMap.has(sector.id));
}

/** Calculate bounding box of all sectors */
function calculateSectorBounds(
  data: MapData,
  scale: number,
  hexSize: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  data.forEach((node) => {
    const world = hexToWorld(node.position[0], node.position[1], scale);
    minX = Math.min(minX, world.x - hexSize);
    minY = Math.min(minY, world.y - hexSize);
    maxX = Math.max(maxX, world.x + hexSize);
    maxY = Math.max(maxY, world.y + hexSize);
  });

  return { minX, minY, maxX, maxY };
}

/** Calculate camera transform to optimally frame all connected sectors */
function calculateCameraTransform(
  data: MapData,
  _currentSectorId: number,
  width: number,
  height: number,
  scale: number,
  hexSize: number,
  framePadding = 0
): { offsetX: number; offsetY: number; zoom: number } {
  const bounds = calculateSectorBounds(data, scale, hexSize);
  const boundsWidth = Math.max(bounds.maxX - bounds.minX, hexSize);
  const boundsHeight = Math.max(bounds.maxY - bounds.minY, hexSize);

  const scaleX = (width - framePadding * 2) / boundsWidth;
  const scaleY = (height - framePadding * 2) / boundsHeight;
  const zoom = Math.min(scaleX, scaleY, 1.5);

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  return { offsetX: -centerX, offsetY: -centerY, zoom };
}

/** Render debug bounding box visualization */
function renderDebugBounds(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  hexSize: number
) {
  const bounds = calculateSectorBounds(data, scale, hexSize);
  ctx.save();
  ctx.strokeStyle = "#00ff00";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  ctx.strokeRect(bounds.minX, bounds.minY, width, height);
  ctx.restore();
}

/** Render directional arrow for one-way lanes */
function renderArrow(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const arrowX = to.x - 15 * Math.cos(angle);
  const arrowY = to.y - 15 * Math.sin(angle);

  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY);
  ctx.lineTo(
    arrowX - 8 * Math.cos(angle - Math.PI / 6),
    arrowY - 8 * Math.sin(angle - Math.PI / 6)
  );
  ctx.moveTo(arrowX, arrowY);
  ctx.lineTo(
    arrowX - 8 * Math.cos(angle + Math.PI / 6),
    arrowY - 8 * Math.sin(angle + Math.PI / 6)
  );
  ctx.stroke();
}

/** Calculate point on hex edge in direction of target */
function getHexEdgePoint(
  center: { x: number; y: number },
  target: { x: number; y: number },
  hexSize: number
): { x: number; y: number } {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance === 0) return center;

  const ratio = hexSize / distance;
  return {
    x: center.x + dx * ratio,
    y: center.y + dy * ratio,
  };
}

/** Render a single lane between two sectors */
function renderLane(
  ctx: CanvasRenderingContext2D,
  lane: MapLane,
  fromNode: MapSectorNode,
  toNode: MapSectorNode,
  scale: number,
  hexSize: number,
  config: MiniMapConfigBase,
  isBidirectional: boolean
) {
  const fromCenter = hexToWorld(
    fromNode.position[0],
    fromNode.position[1],
    scale
  );
  const toCenter = hexToWorld(toNode.position[0], toNode.position[1], scale);

  const from = getHexEdgePoint(fromCenter, toCenter, hexSize);
  const to = getHexEdgePoint(toCenter, fromCenter, hexSize);

  if (lane.hyperlane && config.show_hyperlanes) {
    ctx.strokeStyle = config.colors.hyperlane;
    ctx.lineWidth = 2;
  } else if (isBidirectional) {
    ctx.strokeStyle = config.colors.lane;
    ctx.lineWidth = 1.5;
  } else {
    ctx.strokeStyle = config.colors.lane_one_way;
    ctx.lineWidth = 1.5;
  }

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  if (!isBidirectional) {
    renderArrow(ctx, from, to);
  }
}

/** Find hex edge direction that avoids existing lane directions */
function findAvailableEdgeDirection(
  fromNode: MapSectorNode,
  data: MapData,
  scale: number
): number {
  const usedAngles = fromNode.lanes
    .map((lane) => {
      const toNode = findSector(data, lane.to);
      if (!toNode) return null;
      const fromWorld = hexToWorld(
        fromNode.position[0],
        fromNode.position[1],
        scale
      );
      const toWorld = hexToWorld(toNode.position[0], toNode.position[1], scale);
      return Math.atan2(toWorld.y - fromWorld.y, toWorld.x - fromWorld.x);
    })
    .filter((angle): angle is number => angle !== null);

  const hexDirections = [
    0,
    Math.PI / 3,
    (2 * Math.PI) / 3,
    Math.PI,
    (4 * Math.PI) / 3,
    (5 * Math.PI) / 3,
  ];

  for (const direction of hexDirections) {
    const isAvailable = usedAngles.every((usedAngle) => {
      let diff = Math.abs(direction - usedAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      return diff > Math.PI / 4;
    });
    if (isAvailable) return direction;
  }

  return 0;
}

/** Render short stub for hyperlanes to invisible destinations */
function renderHyperlaneStub(
  ctx: CanvasRenderingContext2D,
  fromNode: MapSectorNode,
  destinationId: number,
  direction: number,
  scale: number,
  hexSize: number,
  config: MiniMapConfigBase
): { x: number; y: number; text: string } | null {
  const fromWorld = hexToWorld(
    fromNode.position[0],
    fromNode.position[1],
    scale
  );

  const stubLength = hexSize * 2;
  const startEdge = getHexEdgePoint(
    fromWorld,
    {
      x: fromWorld.x + Math.cos(direction),
      y: fromWorld.y + Math.sin(direction),
    },
    hexSize
  );
  const endPoint = {
    x: startEdge.x + stubLength * Math.cos(direction),
    y: startEdge.y + stubLength * Math.sin(direction),
  };

  ctx.save();
  ctx.strokeStyle = config.colors.hyperlane;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(startEdge.x, startEdge.y);
  ctx.lineTo(endPoint.x, endPoint.y);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = config.colors.hyperlane;
  ctx.fillStyle = config.colors.hyperlane;
  ctx.lineWidth = 2;
  const arrowSize = 6;
  ctx.beginPath();
  ctx.moveTo(endPoint.x, endPoint.y);
  ctx.lineTo(
    endPoint.x - arrowSize * Math.cos(direction - Math.PI / 6),
    endPoint.y - arrowSize * Math.sin(direction - Math.PI / 6)
  );
  ctx.lineTo(
    endPoint.x - arrowSize * Math.cos(direction + Math.PI / 6),
    endPoint.y - arrowSize * Math.sin(direction + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  return {
    x: endPoint.x + 4,
    y: endPoint.y - 4,
    text: `→${destinationId}`,
  };
}

function getUndirectedLaneKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function hasReciprocalLane(
  fromNode: MapSectorNode,
  toNode: MapSectorNode
): boolean {
  return toNode.lanes.some((candidate) => candidate.to === fromNode.id);
}

/** Render all lanes and return hyperlane stub labels for later rendering */
function renderAllLanes(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  hexSize: number,
  config: MiniMapConfigBase
): Array<{ x: number; y: number; text: string }> {
  const renderedLanes = new Set<string>();
  const hyperlaneLabels: Array<{ x: number; y: number; text: string }> = [];

  data.forEach((fromNode) => {
    fromNode.lanes.forEach((lane) => {
      const toNode = findSector(data, lane.to);

      if (!toNode) {
        if (lane.hyperlane && config.show_hyperlanes) {
          const direction = findAvailableEdgeDirection(fromNode, data, scale);
          const labelInfo = renderHyperlaneStub(
            ctx,
            fromNode,
            lane.to,
            direction,
            scale,
            hexSize,
            config
          );
          if (labelInfo) {
            hyperlaneLabels.push(labelInfo);
          }
        }
        return;
      }

      const isBidirectional =
        lane.two_way || hasReciprocalLane(fromNode, toNode);

      if (isBidirectional) {
        const laneKey = getUndirectedLaneKey(fromNode.id, lane.to);
        if (renderedLanes.has(laneKey)) return;
        renderedLanes.add(laneKey);
      }

      renderLane(
        ctx,
        lane,
        fromNode,
        toNode,
        scale,
        hexSize,
        config,
        isBidirectional
      );
    });
  });

  return hyperlaneLabels;
}

/** Apply opacity to color (multiplies existing alpha if present) */
function applyAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (color.startsWith("rgba")) {
    const match = color.match(
      /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/
    );
    if (match) {
      const existingAlpha = parseFloat(match[4]);
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${
        existingAlpha * alpha
      })`;
    }
    return color.replace(/[\d.]+\)$/, `${alpha})`);
  }
  if (color.startsWith("rgb")) {
    const match = color.match(/rgb\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
    if (match) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
    }
  }
  return color;
}

/** Render a sector hex with optional opacity for fade effects */
function renderSector(
  ctx: CanvasRenderingContext2D,
  node: MapSectorNode,
  scale: number,
  hexSize: number,
  config: MiniMapConfigBase,
  currentRegion?: string,
  opacity = 1
) {
  const world = hexToWorld(node.position[0], node.position[1], scale);
  const isCurrent = node.id === config.current_sector_id;
  const isVisited = Boolean(node.visited) || isCurrent;
  const isCrossRegion =
    currentRegion && node.region && node.region !== currentRegion;

  if (isCurrent && config.current_sector_outer_border) {
    const outerBorderSize = config.current_sector_outer_border;
    ctx.save();
    ctx.strokeStyle = applyAlpha(config.colors.current_outline, opacity);
    ctx.lineWidth = outerBorderSize;
    drawHex(ctx, world.x, world.y, hexSize + outerBorderSize / 2 + 2, false);
    ctx.restore();
  }

  const fillColor = isVisited ? config.colors.visited : config.colors.empty;
  ctx.fillStyle = applyAlpha(fillColor, opacity);

  let strokeColor: string;
  if (isCurrent) {
    strokeColor = config.colors.current;
    ctx.lineWidth = 2;
  } else if (isCrossRegion) {
    strokeColor = config.colors.cross_region_outline;
    ctx.lineWidth = 2;
  } else {
    strokeColor = config.colors.sector_border;
    ctx.lineWidth = 1;
  }
  ctx.strokeStyle = applyAlpha(strokeColor, opacity);

  drawHex(ctx, world.x, world.y, hexSize, true);

  if (config.show_ports && node.port) {
    const isMegaPort = node.is_mega || node.id === 0;
    const portColor = isMegaPort ? config.colors.mega_port : config.colors.port;
    ctx.fillStyle = applyAlpha(portColor, opacity);
    ctx.beginPath();
    ctx.arc(world.x, world.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Render hex grid background covering viewport */
function renderHexGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cameraZoom: number,
  cameraOffsetX: number,
  cameraOffsetY: number,
  scale: number,
  hexSize: number,
  gridColor: string
) {
  const stepX = scale * 1.5;
  const invScale = 1 / scale;
  const sqrt3 = Math.sqrt(3);

  const worldLeft = -width / 2 / cameraZoom - cameraOffsetX;
  const worldRight = width / 2 / cameraZoom - cameraOffsetX;
  const worldTop = -height / 2 / cameraZoom - cameraOffsetY;
  const worldBottom = height / 2 / cameraZoom - cameraOffsetY;

  const minHexX = Math.floor(worldLeft / stepX) - 2;
  let maxHexX = Math.ceil(worldRight / stepX) + 2;

  if (maxHexX - minHexX > 500) {
    maxHexX = minHexX + 500;
  }

  ctx.save();
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;

  for (let hx = minHexX; hx <= maxHexX; hx++) {
    const yOffset = 0.5 * (hx & 1);
    const minHexY = Math.floor((worldTop * invScale) / sqrt3 - yOffset) - 2;
    const maxHexY = Math.ceil((worldBottom * invScale) / sqrt3 - yOffset) + 2;

    for (let hy = minHexY; hy <= maxHexY; hy++) {
      const world = hexToWorld(hx, hy, scale);
      drawHex(ctx, world.x, world.y, hexSize);
    }
  }

  ctx.restore();
}

/** Apply a rectangular feather mask around the edges in screen space */
function applyRectangularFeatherMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  featherSize: number
) {
  if (featherSize <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";

  // Top edge
  let gradient = ctx.createLinearGradient(0, 0, 0, featherSize);
  gradient.addColorStop(0, "rgba(0,0,0,1)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, featherSize);

  // Bottom edge
  gradient = ctx.createLinearGradient(0, height - featherSize, 0, height);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, height - featherSize, width, featherSize);

  // Left edge
  gradient = ctx.createLinearGradient(0, 0, featherSize, 0);
  gradient.addColorStop(0, "rgba(0,0,0,1)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, featherSize, height);

  // Right edge
  gradient = ctx.createLinearGradient(width - featherSize, 0, width, 0);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = gradient;
  ctx.fillRect(width - featherSize, 0, featherSize, height);

  ctx.restore();
}

/** Calculate complete camera state for given props */
function calculateCameraState(
  data: MapData,
  config: MiniMapConfigBase,
  width: number,
  height: number,
  scale: number,
  hexSize: number,
  maxDistance: number
): CameraState | null {
  const reachableMap = calculateReachableSectors(
    data,
    config.current_sector_id,
    maxDistance
  );
  const filteredData = filterReachableSectors(data, reachableMap);

  if (filteredData.length === 0) {
    return null;
  }

  const camera = calculateCameraTransform(
    filteredData,
    config.current_sector_id,
    width,
    height,
    scale,
    hexSize,
    config.frame_padding ?? 0
  );

  return {
    offsetX: camera.offsetX,
    offsetY: camera.offsetY,
    zoom: camera.zoom,
    filteredData,
  };
}

/** Convert world coordinates to screen coordinates */
function worldToScreen(
  worldX: number,
  worldY: number,
  width: number,
  height: number,
  cameraState: CameraState
): { x: number; y: number } {
  return {
    x: (worldX + cameraState.offsetX) * cameraState.zoom + width / 2,
    y: (worldY + cameraState.offsetY) * cameraState.zoom + height / 2,
  };
}

/** Render sector ID labels at top-right of hexes */
function renderSectorLabels(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  hexSize: number,
  width: number,
  height: number,
  cameraState: CameraState,
  config: MiniMapConfigBase
) {
  if (!config.show_sector_ids) return;

  ctx.save();
  ctx.font = "8px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const labelOffset = config.sector_label_offset ?? 2;
  const padding = 1;

  data.forEach((node) => {
    const worldPos = hexToWorld(node.position[0], node.position[1], scale);
    const angle = -Math.PI / 3;
    const edgeWorldX = worldPos.x + hexSize * Math.cos(angle);
    const edgeWorldY = worldPos.y + hexSize * Math.sin(angle);

    const screenPos = worldToScreen(
      edgeWorldX,
      edgeWorldY,
      width,
      height,
      cameraState
    );

    const text = node.id.toString();
    const textX = screenPos.x + labelOffset;
    const textY = screenPos.y;

    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = 8;

    ctx.fillStyle = config.colors.label_bg;
    ctx.fillRect(
      textX - padding,
      textY - padding,
      textWidth + padding * 2,
      textHeight + padding * 2
    );

    ctx.fillStyle = config.colors.label;
    ctx.fillText(text, textX, textY);
  });

  ctx.restore();
}

/** Render port code labels at bottom-right of hexes */
function renderPortLabels(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  hexSize: number,
  width: number,
  height: number,
  cameraState: CameraState,
  config: MiniMapConfigBase
) {
  if (!config.show_ports) return;

  ctx.save();
  ctx.font = "8px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const labelOffset = config.sector_label_offset ?? 2;
  const padding = 1;

  data.forEach((node) => {
    if (!node.port) return;

    const worldPos = hexToWorld(node.position[0], node.position[1], scale);
    const angle = Math.PI / 3;
    const edgeWorldX = worldPos.x + hexSize * Math.cos(angle);
    const edgeWorldY = worldPos.y + hexSize * Math.sin(angle);

    const screenPos = worldToScreen(
      edgeWorldX,
      edgeWorldY,
      width,
      height,
      cameraState
    );

    const text = node.port;
    const textX = screenPos.x + labelOffset;
    const textY = screenPos.y;

    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = 8;

    ctx.fillStyle = config.colors.label_bg;
    ctx.fillRect(
      textX - padding,
      textY - padding,
      textWidth + padding * 2,
      textHeight + padding * 2
    );

    ctx.fillStyle = config.colors.label;
    ctx.fillText(text, textX, textY);
  });

  ctx.restore();
}

/** Core rendering with explicit camera state */
function renderWithCameraState(
  canvas: HTMLCanvasElement,
  props: MiniMapProps,
  cameraState: CameraState
) {
  const { width, height, config } = props;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = config.colors.background;
  ctx.fillRect(0, 0, width, height);

  const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
  const hexSize = config.hex_size ?? gridSpacing * 0.85;
  const scale = gridSpacing;

  // 1) Draw grid in world space
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(cameraState.zoom, cameraState.zoom);
  ctx.translate(cameraState.offsetX, cameraState.offsetY);

  if (config.show_grid) {
    renderHexGrid(
      ctx,
      width,
      height,
      cameraState.zoom,
      cameraState.offsetX,
      cameraState.offsetY,
      scale,
      hexSize,
      config.colors.grid
    );
  }
  ctx.restore();

  // 2) Apply rectangular feather mask to background + grid (screen space)
  const featherSize = Math.min(
    config.edge_feather_size ?? 40,
    Math.min(width, height) / 2
  );
  applyRectangularFeatherMask(ctx, width, height, featherSize);

  // 3) Draw lanes and sectors in world space (unmasked)
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(cameraState.zoom, cameraState.zoom);
  ctx.translate(cameraState.offsetX, cameraState.offsetY);

  const hyperlaneLabels = config.show_warps
    ? renderAllLanes(ctx, cameraState.filteredData, scale, hexSize, config)
    : [];

  const currentSector = findSector(
    cameraState.filteredData,
    config.current_sector_id
  );
  const currentRegion = currentSector?.region;

  const fadingInIds = new Set(cameraState.fadingInData?.map((s) => s.id) ?? []);

  if (cameraState.fadingOutData && cameraState.fadeProgress !== undefined) {
    const fadeOpacity = 1 - cameraState.fadeProgress;
    cameraState.fadingOutData.forEach((node) => {
      renderSector(
        ctx,
        node,
        scale,
        hexSize,
        config,
        currentRegion,
        fadeOpacity
      );
    });
  }

  cameraState.filteredData.forEach((node) => {
    const opacity =
      fadingInIds.has(node.id) && cameraState.fadeProgress !== undefined
        ? cameraState.fadeProgress
        : 1;
    renderSector(ctx, node, scale, hexSize, config, currentRegion, opacity);
  });

  if (config.debug) {
    renderDebugBounds(ctx, cameraState.filteredData, scale, hexSize);
  }

  ctx.restore();

  renderSectorLabels(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    width,
    height,
    cameraState,
    config
  );
  renderPortLabels(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    width,
    height,
    cameraState,
    config
  );

  if (hyperlaneLabels.length > 0) {
    ctx.save();
    ctx.font = "8px monospace";
    hyperlaneLabels.forEach((label) => {
      const screenPos = worldToScreen(
        label.x,
        label.y,
        width,
        height,
        cameraState
      );
      const metrics = ctx.measureText(label.text);

      ctx.fillStyle = config.colors.label_bg;
      ctx.fillRect(screenPos.x - 1, screenPos.y - 7, metrics.width + 2, 10);

      ctx.fillStyle = config.colors.label;
      ctx.fillText(label.text, screenPos.x, screenPos.y);
    });
    ctx.restore();
  }
}

export interface MiniMapController {
  render: () => void;
  moveToSector: (newSectorId: number, newMapData?: MapData) => void;
  getCurrentState: () => CameraState | null;
  updateProps: (newProps: Partial<MiniMapProps>) => void;
}

/** Create minimap controller with imperative API */
export function createMiniMapController(
  canvas: HTMLCanvasElement,
  props: MiniMapProps
): MiniMapController {
  let currentCameraState: CameraState | null = null;
  let currentProps = { ...props };
  let animationCleanup: (() => void) | null = null;
  let animationCompletionTimeout: number | null = null;

  const render = () => {
    const { width, height, data, config, maxDistance = 3 } = currentProps;
    const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
    const hexSize = config.hex_size ?? gridSpacing * 0.85;
    const scale = gridSpacing;

    const cameraState = calculateCameraState(
      data,
      config,
      width,
      height,
      scale,
      hexSize,
      maxDistance
    );

    if (!cameraState) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);
        ctx.fillStyle = config.colors.background;
        ctx.fillRect(0, 0, width, height);
        const feather = Math.min(
          config.edge_feather_size ?? 40,
          Math.min(width, height) / 2
        );
        applyRectangularFeatherMask(ctx, width, height, feather);
      }
      return;
    }

    renderWithCameraState(canvas, currentProps, cameraState);
    currentCameraState = cameraState;
  };

  const moveToSector = (newSectorId: number, newMapData?: MapData) => {
    if (animationCleanup) {
      animationCleanup();
      animationCleanup = null;
    }
    if (animationCompletionTimeout !== null) {
      window.clearTimeout(animationCompletionTimeout);
      animationCompletionTimeout = null;
    }

    const updatedProps = {
      ...currentProps,
      data: newMapData ?? currentProps.data,
      config: { ...currentProps.config, current_sector_id: newSectorId },
    };
    currentProps = updatedProps;

    if (currentCameraState) {
      animationCleanup = updateCurrentSector(
        canvas,
        updatedProps,
        newSectorId,
        currentCameraState
      );

      const animDuration = Math.max(
        updatedProps.config.animation_duration_pan,
        updatedProps.config.animation_duration_zoom
      );

      animationCompletionTimeout = window.setTimeout(() => {
        currentCameraState = getCurrentCameraState(updatedProps);
        animationCleanup = null;
        animationCompletionTimeout = null;
      }, animDuration);
    } else {
      render();
    }
  };

  const getCurrentState = () => currentCameraState;

  const updateProps = (newProps: Partial<MiniMapProps>) => {
    Object.assign(currentProps, newProps);
    if (newProps.config) {
      Object.assign(currentProps.config, newProps.config);
    }
  };

  render();

  return { render, moveToSector, getCurrentState, updateProps };
}

/** Render minimap canvas (stateless) */
export function renderMiniMapCanvas(
  canvas: HTMLCanvasElement,
  props: MiniMapProps
) {
  const { width, height, data, config, maxDistance = 3 } = props;

  const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
  const hexSize = config.hex_size ?? gridSpacing * 0.85;
  const scale = gridSpacing;

  const cameraState = calculateCameraState(
    data,
    config,
    width,
    height,
    scale,
    hexSize,
    maxDistance
  );

  if (!cameraState) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = config.colors.background;
      ctx.fillRect(0, 0, width, height);
      const feather = Math.min(
        config.edge_feather_size ?? 40,
        Math.min(width, height) / 2
      );
      applyRectangularFeatherMask(ctx, width, height, feather);
    }
    return;
  }

  renderWithCameraState(canvas, props, cameraState);
}

/** Get current camera state for tracking between renders */
export function getCurrentCameraState(props: MiniMapProps): CameraState | null {
  const { width, height, data, config, maxDistance = 3 } = props;
  const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
  const hexSize = config.hex_size ?? gridSpacing * 0.85;
  const scale = gridSpacing;
  return calculateCameraState(
    data,
    config,
    width,
    height,
    scale,
    hexSize,
    maxDistance
  );
}

/** Animate transition to new sector */
export function updateCurrentSector(
  canvas: HTMLCanvasElement,
  props: MiniMapProps,
  newSectorId: number,
  currentCameraState: CameraState | null
): () => void {
  const { width, height, data, config, maxDistance = 3 } = props;

  const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
  const hexSize = config.hex_size ?? gridSpacing * 0.85;
  const scale = gridSpacing;

  const newConfig = { ...config, current_sector_id: newSectorId };

  const targetCameraState = calculateCameraState(
    data,
    newConfig,
    width,
    height,
    scale,
    hexSize,
    maxDistance
  );

  if (!targetCameraState) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = config.colors.background;
      ctx.fillRect(0, 0, width, height);
      const feather = Math.min(
        config.edge_feather_size ?? 40,
        Math.min(width, height) / 2
      );
      applyRectangularFeatherMask(ctx, width, height, feather);
    }
    return () => {};
  }

  if (!currentCameraState || config.bypass_animation) {
    renderWithCameraState(
      canvas,
      { ...props, config: newConfig },
      targetCameraState
    );
    return () => {};
  }

  const currentDataIds = new Set(
    currentCameraState.filteredData.map((s) => s.id)
  );
  const targetDataIds = new Set(
    targetCameraState.filteredData.map((s) => s.id)
  );

  const fadingOutData = currentCameraState.filteredData.filter(
    (s) => !targetDataIds.has(s.id)
  );
  const fadingInData = targetCameraState.filteredData.filter(
    (s) => !currentDataIds.has(s.id)
  );

  const startCameraWithFade: CameraState = {
    offsetX: currentCameraState.offsetX,
    offsetY: currentCameraState.offsetY,
    zoom: currentCameraState.zoom,
    filteredData: targetCameraState.filteredData,
    fadingOutData,
    fadingInData,
    fadeProgress: 0,
  };

  const panDuration = config.animation_duration_pan;
  const zoomDuration = config.animation_duration_zoom;
  const fadeDuration = Math.max(panDuration, zoomDuration);

  const animationState: AnimationState = {
    isAnimating: true,
    startTime: performance.now(),
    panDuration,
    zoomDuration,
    fadeDuration,
    startCamera: startCameraWithFade,
    targetCamera: targetCameraState,
  };

  const animate = (currentTime: number) => {
    if (!animationState.isAnimating) return;

    const elapsed = currentTime - animationState.startTime;
    const panProgress = Math.min(elapsed / animationState.panDuration, 1);
    const zoomProgress = Math.min(elapsed / animationState.zoomDuration, 1);
    const fadeProgress = Math.min(elapsed / animationState.fadeDuration, 1);

    const interpolatedCamera = interpolateCameraState(
      animationState.startCamera,
      animationState.targetCamera,
      panProgress,
      zoomProgress,
      fadeProgress
    );

    renderWithCameraState(
      canvas,
      { ...props, config: newConfig },
      interpolatedCamera
    );

    if (fadeProgress < 1) {
      animationState.animationFrameId = requestAnimationFrame(animate);
    } else {
      animationState.isAnimating = false;
    }
  };

  animationState.animationFrameId = requestAnimationFrame(animate);

  return () => {
    animationState.isAnimating = false;
    if (animationState.animationFrameId !== undefined) {
      cancelAnimationFrame(animationState.animationFrameId);
    }
  };
}
