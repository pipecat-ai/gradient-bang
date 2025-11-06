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
    muted: string;
    muted_lane: string;
    course_plot_start: string;
    course_plot_end: string;
    course_plot_mid: string;
  };
  grid_spacing: number;
  hex_size: number;
  sector_label_offset: number;
  label_font_size: number;
  label_font_weight: number | string;
  label_padding: number;
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
  show_partial_lanes: boolean;
  /** Maximum distance in hex tiles from current sector to include in bounds calculation. Sectors beyond this distance are ignored for framing but still rendered if within maxDistance hops. */
  max_bounds_distance?: number;
  /** Opacity for sectors/lanes not in the course plot (0-1) */
  muted_opacity: number;
  course_plot_sector_border: number;
  course_plot_lane_width: number;
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
    current: "rgba(74,144,226,0.4)",
    current_outline: "rgba(74,144,226,0.6)",
    muted: "rgba(40,40,40,0.5)",
    muted_lane: "rgba(80,80,80,0.4)",
    course_plot_start: "rgba(50,200,50,0.9)",
    course_plot_end: "rgba(220,50,50,0.9)",
    course_plot_mid: "rgba(100,150,255,0.5)",
  },
  grid_spacing: 30,
  hex_size: 20,
  sector_label_offset: 5,
  label_font_size: 10,
  label_font_weight: 800,
  label_padding: 2,
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
  show_hyperlanes: false,
  show_partial_lanes: true,
  max_bounds_distance: 7,
  muted_opacity: 0.3,
  course_plot_sector_border: 3,
  course_plot_lane_width: 3,
};

export interface MiniMapProps {
  width: number;
  height: number;
  data: MapData;
  config: MiniMapConfigBase;
  maxDistance?: number;
  coursePlot?: CoursePlot | null;
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

/** Build an index for O(1) sector lookups by id */
function createSectorIndex(data: MapData): Map<number, MapSectorNode> {
  const index = new Map<number, MapSectorNode>();
  data.forEach((sector) => index.set(sector.id, sector));
  return index;
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
  const index = createSectorIndex(data);
  const currentSector = index.get(currentSectorId);
  if (!currentSector) return reachableMap;

  const queue: Array<{ id: number; distance: number }> = [
    { id: currentSectorId, distance: 0 },
  ];
  let head = 0;
  const visited = new Set<number>([currentSectorId]);
  reachableMap.set(currentSectorId, 0);

  while (head < queue.length) {
    const current = queue[head++];
    if (current.distance >= maxDistance) continue;

    const sector = index.get(current.id);
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
  currentSectorId: number,
  width: number,
  height: number,
  scale: number,
  hexSize: number,
  framePadding = 0,
  maxBoundsDistanceHexes?: number
): { offsetX: number; offsetY: number; zoom: number } {
  // Filter data for bounds calculation if maxBoundsDistanceHexes is set
  let boundsData = data;
  if (maxBoundsDistanceHexes !== undefined) {
    const currentSector = data.find((s) => s.id === currentSectorId);
    if (currentSector) {
      // Convert hex tile units to world-space distance
      // Using vertical spacing (scale * sqrt(3)) as the base unit for hex distance
      const maxWorldDistance = maxBoundsDistanceHexes * scale * Math.sqrt(3);

      const currentWorld = hexToWorld(
        currentSector.position[0],
        currentSector.position[1],
        scale
      );
      boundsData = data.filter((node) => {
        const world = hexToWorld(node.position[0], node.position[1], scale);
        const dx = world.x - currentWorld.x;
        const dy = world.y - currentWorld.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        return distance <= maxWorldDistance;
      });
      // Ensure we have at least the current sector
      if (boundsData.length === 0) {
        boundsData = [currentSector];
      }
    }
  }

  const bounds = calculateSectorBounds(boundsData, scale, hexSize);
  const boundsWidth = Math.max(bounds.maxX - bounds.minX, hexSize);
  const boundsHeight = Math.max(bounds.maxY - bounds.minY, hexSize);

  const scaleX = (width - framePadding * 2) / boundsWidth;
  const scaleY = (height - framePadding * 2) / boundsHeight;
  const zoom = Math.max(0.3, Math.min(scaleX, scaleY, 1.5));

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
  isBidirectional: boolean,
  coursePlotLanes: Set<string> | null = null,
  coursePlot: CoursePlot | null = null
) {
  const fromCenter = hexToWorld(
    fromNode.position[0],
    fromNode.position[1],
    scale
  );
  const toCenter = hexToWorld(toNode.position[0], toNode.position[1], scale);

  const from = getHexEdgePoint(fromCenter, toCenter, hexSize);
  const to = getHexEdgePoint(toCenter, fromCenter, hexSize);

  // Apply course plot logic
  let laneWidth = 1.5;
  let isInPlot = true;

  if (coursePlotLanes) {
    const laneKey = getUndirectedLaneKey(fromNode.id, toNode.id);
    isInPlot = coursePlotLanes.has(laneKey);
    if (isInPlot) {
      laneWidth = config.course_plot_lane_width;
    }
  }

  // Use muted_lane color for lanes not in course plot
  if (coursePlotLanes && !isInPlot) {
    ctx.strokeStyle = config.colors.muted_lane;
    ctx.lineWidth = 1.5;
  } else if (lane.hyperlane && config.show_hyperlanes) {
    ctx.strokeStyle = config.colors.hyperlane;
    ctx.lineWidth = isInPlot ? laneWidth : 2;
  } else if (isBidirectional) {
    ctx.strokeStyle = config.colors.lane;
    ctx.lineWidth = laneWidth;
  } else {
    ctx.strokeStyle = config.colors.lane_one_way;
    ctx.lineWidth = laneWidth;
  }

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  // Check if this lane is in the course plot and needs a directional arrow
  let needsArrow = !isBidirectional;
  let arrowFrom = from;
  let arrowTo = to;

  if (coursePlot && isInPlot) {
    // Find the direction of travel in the course plot
    const fromIndex = coursePlot.path.indexOf(fromNode.id);
    const toIndex = coursePlot.path.indexOf(toNode.id);

    if (
      fromIndex !== -1 &&
      toIndex !== -1 &&
      Math.abs(fromIndex - toIndex) === 1
    ) {
      needsArrow = true;
      // Determine the correct direction based on path order
      if (fromIndex < toIndex) {
        // fromNode -> toNode is the correct direction
        arrowFrom = from;
        arrowTo = to;
      } else {
        // toNode -> fromNode is the correct direction
        arrowFrom = to;
        arrowTo = from;
      }
    }
  }

  if (needsArrow) {
    renderArrow(ctx, arrowFrom, arrowTo);
  }
}

/** Find hex edge direction that avoids existing lane directions */

/** Index-aware variant to avoid repeated linear lookups */
function findAvailableEdgeDirectionWithIndex(
  fromNode: MapSectorNode,
  index: Map<number, MapSectorNode>,
  scale: number
): number {
  const usedAngles = fromNode.lanes
    .map((lane) => {
      const toNode = index.get(lane.to);
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

/** Render a partial lane from an edge node to a culled (but visited) destination */
function renderPartialLane(
  ctx: CanvasRenderingContext2D,
  fromNode: MapSectorNode,
  culledToNode: MapSectorNode,
  scale: number,
  hexSize: number,
  config: MiniMapConfigBase,
  coursePlotLanes: Set<string> | null = null,
  coursePlot: CoursePlot | null = null
) {
  const fromCenter = hexToWorld(
    fromNode.position[0],
    fromNode.position[1],
    scale
  );
  const toCenter = hexToWorld(
    culledToNode.position[0],
    culledToNode.position[1],
    scale
  );

  const from = getHexEdgePoint(fromCenter, toCenter, hexSize);
  const to = getHexEdgePoint(toCenter, fromCenter, hexSize);

  // Apply course plot logic
  let laneWidth = 1.5;
  let isInPlot = true;

  if (coursePlotLanes) {
    const laneKey = getUndirectedLaneKey(fromNode.id, culledToNode.id);
    isInPlot = coursePlotLanes.has(laneKey);
    if (isInPlot) {
      laneWidth = config.course_plot_lane_width;
    }
  }

  ctx.save();
  // Use muted_lane color for partial lanes not in course plot
  if (coursePlotLanes && !isInPlot) {
    ctx.strokeStyle = config.colors.muted_lane;
  } else {
    ctx.strokeStyle = config.colors.lane;
  }
  ctx.lineWidth = laneWidth;
  ctx.setLineDash([3, 3]); // Dashed to indicate it leads to culled sector

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  // Add arrow for partial lanes in course plot
  if (coursePlot && isInPlot) {
    const fromIndex = coursePlot.path.indexOf(fromNode.id);
    const toIndex = coursePlot.path.indexOf(culledToNode.id);

    if (
      fromIndex !== -1 &&
      toIndex !== -1 &&
      Math.abs(fromIndex - toIndex) === 1
    ) {
      const arrowFrom = fromIndex < toIndex ? from : to;
      const arrowTo = fromIndex < toIndex ? to : from;
      renderArrow(ctx, arrowFrom, arrowTo);
    }
  }

  ctx.restore();
}

/** Render all lanes and return hyperlane stub labels for later rendering */
function renderAllLanes(
  ctx: CanvasRenderingContext2D,
  filteredData: MapData,
  fullData: MapData,
  scale: number,
  hexSize: number,
  config: MiniMapConfigBase,
  coursePlotLanes: Set<string> | null = null,
  coursePlot: CoursePlot | null = null
): Array<{ x: number; y: number; text: string }> {
  const renderedLanes = new Set<string>();
  const hyperlaneLabels: Array<{ x: number; y: number; text: string }> = [];
  const filteredIndex = createSectorIndex(filteredData);
  const fullIndex = createSectorIndex(fullData);

  filteredData.forEach((fromNode) => {
    fromNode.lanes.forEach((lane) => {
      const toNode = filteredIndex.get(lane.to);

      if (!toNode) {
        // Check if fromNode is visited and we should render partial lanes
        if (config.show_partial_lanes && fromNode.visited) {
          const culledToNode = fullIndex.get(lane.to);
          if (culledToNode) {
            // Render partial lane to culled but real sector
            renderPartialLane(
              ctx,
              fromNode,
              culledToNode,
              scale,
              hexSize,
              config,
              coursePlotLanes,
              coursePlot
            );
            return;
          }
        }

        // Original hyperlane stub logic for truly missing sectors
        if (lane.hyperlane && config.show_hyperlanes) {
          const direction = findAvailableEdgeDirectionWithIndex(
            fromNode,
            filteredIndex,
            scale
          );
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
        isBidirectional,
        coursePlotLanes,
        coursePlot
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

/** Use the app's computed font-family (canvas or body) for labels */
let cachedFontFamily: string | null = null;
function getCanvasFontFamily(ctx: CanvasRenderingContext2D): string {
  if (cachedFontFamily) return cachedFontFamily;
  try {
    const canvasEl = ctx.canvas as HTMLCanvasElement | undefined;
    const canvasFamily = canvasEl
      ? window.getComputedStyle(canvasEl).fontFamily
      : "";
    const bodyFamily = window.getComputedStyle(document.body).fontFamily;
    cachedFontFamily = canvasFamily || bodyFamily || "sans-serif";
  } catch {
    cachedFontFamily = "sans-serif";
  }
  return cachedFontFamily;
}

/** Render a sector hex with optional opacity for fade effects */
function renderSector(
  ctx: CanvasRenderingContext2D,
  node: MapSectorNode,
  scale: number,
  hexSize: number,
  config: MiniMapConfigBase,
  currentRegion?: string,
  opacity = 1,
  coursePlotSectors: Set<number> | null = null,
  coursePlot: CoursePlot | null = null
) {
  const world = hexToWorld(node.position[0], node.position[1], scale);
  const isCurrent = node.id === config.current_sector_id;
  const isVisited = Boolean(node.visited) || isCurrent;
  const isCrossRegion =
    currentRegion && node.region && node.region !== currentRegion;

  // Apply course plot logic
  const finalOpacity = opacity;
  let baseLineWidth = 1;
  let isInPlot = true;

  if (coursePlotSectors) {
    isInPlot = coursePlotSectors.has(node.id);
    if (isInPlot) {
      baseLineWidth = config.course_plot_sector_border;
    }
  }

  if (isCurrent && config.current_sector_outer_border) {
    const outerBorderSize = config.current_sector_outer_border;
    ctx.save();
    ctx.strokeStyle = applyAlpha(config.colors.current_outline, finalOpacity);
    ctx.lineWidth = outerBorderSize;
    drawHex(ctx, world.x, world.y, hexSize + outerBorderSize / 2 + 2, false);
    ctx.restore();
  }

  // Add special outline for start/end sectors in course plot
  if (coursePlot) {
    const isStart = node.id === coursePlot.from_sector;
    const isEnd = node.id === coursePlot.to_sector;

    if (isStart || isEnd) {
      const outlineSize = 4;
      ctx.save();
      ctx.strokeStyle = isStart
        ? config.colors.course_plot_start
        : config.colors.course_plot_end;
      ctx.lineWidth = outlineSize;
      drawHex(ctx, world.x, world.y, hexSize + outlineSize / 2 + 1, false);
      ctx.restore();
    }
  }

  // Use muted color for sectors not in course plot, special colors for plot sectors
  let fillColor: string;
  if (coursePlotSectors && !isInPlot) {
    fillColor = config.colors.muted;
  } else if (coursePlot && isInPlot) {
    // Apply special colors to course plot sectors
    const isStart = node.id === coursePlot.from_sector;
    const isEnd = node.id === coursePlot.to_sector;

    if (isCurrent) {
      fillColor = config.colors.current;
    } else if (isStart || isEnd) {
      // Start and end sectors keep their normal visited/empty colors
      fillColor = isVisited ? config.colors.visited : config.colors.empty;
    } else {
      // Middle sectors get the special course_plot_mid color
      fillColor = config.colors.course_plot_mid;
    }
  } else {
    fillColor = isCurrent
      ? config.colors.current
      : isVisited
      ? config.colors.visited
      : config.colors.empty;
  }
  ctx.fillStyle = applyAlpha(fillColor, finalOpacity);

  let strokeColor: string;
  if (coursePlotSectors && !isInPlot) {
    strokeColor = config.colors.muted;
    ctx.lineWidth = baseLineWidth;
  } else if (isCurrent) {
    strokeColor = config.colors.current;
    ctx.lineWidth = Math.max(2, baseLineWidth);
  } else if (isCrossRegion) {
    strokeColor = config.colors.cross_region_outline;
    ctx.lineWidth = Math.max(2, baseLineWidth);
  } else {
    strokeColor = config.colors.sector_border;
    ctx.lineWidth = baseLineWidth;
  }
  ctx.strokeStyle = applyAlpha(strokeColor, finalOpacity);

  drawHex(ctx, world.x, world.y, hexSize, true);

  if (config.show_ports && node.port) {
    const isMegaPort = node.is_mega || node.id === 0;
    // Use muted color for ports not in course plot
    let portColor: string;
    if (coursePlotSectors && !isInPlot) {
      portColor = config.colors.muted;
    } else {
      portColor = isMegaPort ? config.colors.mega_port : config.colors.port;
    }
    ctx.fillStyle = applyAlpha(portColor, finalOpacity);
    ctx.beginPath();
    ctx.arc(world.x, world.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Render hop number for sectors in course plot
  if (coursePlot && isInPlot) {
    const hopIndex = coursePlot.path.indexOf(node.id);
    if (hopIndex !== -1) {
      const hopNumber = hopIndex + 1;
      ctx.save();
      ctx.font = `bold ${hexSize * 0.8}px ${getCanvasFontFamily(ctx)}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = applyAlpha("#ffffff", finalOpacity * 0.9);
      ctx.strokeStyle = applyAlpha("#000000", finalOpacity * 0.8);
      ctx.lineWidth = 3;
      ctx.strokeText(hopNumber.toString(), world.x, world.y);
      ctx.fillText(hopNumber.toString(), world.x, world.y);
      ctx.restore();
    }
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
  maxDistance: number,
  coursePlot?: CoursePlot | null
): CameraState | null {
  const reachableMap = calculateReachableSectors(
    data,
    config.current_sector_id,
    maxDistance
  );
  let filteredData = filterReachableSectors(data, reachableMap);

  // If course plot exists, include all sectors from the path
  let framingData = filteredData; // Data used for camera framing
  if (coursePlot) {
    const coursePlotSectorIds = new Set(coursePlot.path);
    const sectorIndex = createSectorIndex(data);
    const coursePlotSectors: MapData = [];
    const additionalSectors: MapData = [];

    coursePlotSectorIds.forEach((sectorId) => {
      const sector = sectorIndex.get(sectorId);
      if (sector) {
        coursePlotSectors.push(sector);
        // Only add to filtered if not already there
        if (!filteredData.some((s) => s.id === sectorId)) {
          additionalSectors.push(sector);
        }
      }
    });

    if (additionalSectors.length > 0) {
      filteredData = [...filteredData, ...additionalSectors];
    }

    // Frame around only the course plot sectors
    if (coursePlotSectors.length > 0) {
      framingData = coursePlotSectors;
    }
  }

  if (filteredData.length === 0) {
    return null;
  }

  const camera = calculateCameraTransform(
    framingData,
    config.current_sector_id,
    width,
    height,
    scale,
    hexSize,
    config.frame_padding ?? 0,
    config.max_bounds_distance
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
  config: MiniMapConfigBase,
  coursePlotSectors: Set<number> | null = null
) {
  if (!config.show_sector_ids) return;

  ctx.save();
  ctx.font = `${config.label_font_weight} ${
    config.label_font_size
  }px ${getCanvasFontFamily(ctx)}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const labelOffset = config.sector_label_offset ?? 2;
  const padding = config.label_padding ?? 2;

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
    const ascent =
      metrics.fontBoundingBoxAscent ??
      metrics.actualBoundingBoxAscent ??
      config.label_font_size;
    const descent =
      metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 0;
    const textHeight = ascent + descent;

    // Apply muted opacity to labels for sectors not in course plot
    const labelOpacity =
      coursePlotSectors && !coursePlotSectors.has(node.id)
        ? config.muted_opacity
        : 1;

    ctx.fillStyle = applyAlpha(config.colors.label_bg, labelOpacity);
    ctx.fillRect(
      textX - padding,
      textY - ascent - padding,
      textWidth + padding * 2,
      textHeight + padding * 2
    );

    ctx.fillStyle = applyAlpha(config.colors.label, labelOpacity);
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
  config: MiniMapConfigBase,
  coursePlotSectors: Set<number> | null = null
) {
  if (!config.show_ports) return;

  ctx.save();
  ctx.font = `${config.label_font_weight} ${
    config.label_font_size
  }px ${getCanvasFontFamily(ctx)}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const labelOffset = config.sector_label_offset ?? 2;
  const padding = config.label_padding ?? 2;

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
    const ascent =
      metrics.fontBoundingBoxAscent ??
      metrics.actualBoundingBoxAscent ??
      config.label_font_size;
    const descent =
      metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 0;
    const textHeight = ascent + descent;

    // Apply muted opacity to labels for sectors not in course plot
    const labelOpacity =
      coursePlotSectors && !coursePlotSectors.has(node.id)
        ? config.muted_opacity
        : 1;

    ctx.fillStyle = applyAlpha(config.colors.label_bg, labelOpacity);
    ctx.fillRect(
      textX - padding,
      textY - ascent - padding,
      textWidth + padding * 2,
      textHeight + padding * 2
    );

    ctx.fillStyle = applyAlpha(config.colors.label, labelOpacity);
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
  const { width, height, config, coursePlot } = props;
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

  // Pre-compute course plot Sets for O(1) lookups
  const coursePlotSectors = coursePlot ? new Set(coursePlot.path) : null;
  const coursePlotLanes = coursePlot
    ? new Set(
        coursePlot.path.slice(0, -1).map((from, i) => {
          const to = coursePlot.path[i + 1];
          return getUndirectedLaneKey(from, to);
        })
      )
    : null;

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
    ? renderAllLanes(
        ctx,
        cameraState.filteredData,
        props.data,
        scale,
        hexSize,
        config,
        coursePlotLanes,
        coursePlot
      )
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
        fadeOpacity,
        coursePlotSectors,
        coursePlot
      );
    });
  }

  cameraState.filteredData.forEach((node) => {
    const opacity =
      fadingInIds.has(node.id) && cameraState.fadeProgress !== undefined
        ? cameraState.fadeProgress
        : 1;
    renderSector(
      ctx,
      node,
      scale,
      hexSize,
      config,
      currentRegion,
      opacity,
      coursePlotSectors,
      coursePlot
    );
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
    config,
    coursePlotSectors
  );
  renderPortLabels(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    width,
    height,
    cameraState,
    config,
    coursePlotSectors
  );

  if (hyperlaneLabels.length > 0) {
    ctx.save();
    ctx.font = `${config.label_font_weight} ${
      config.label_font_size
    }px ${getCanvasFontFamily(ctx)}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    hyperlaneLabels.forEach((label) => {
      const screenPos = worldToScreen(
        label.x,
        label.y,
        width,
        height,
        cameraState
      );
      const metrics = ctx.measureText(label.text);
      const ascent = metrics.actualBoundingBoxAscent ?? config.label_font_size;
      const descent = metrics.actualBoundingBoxDescent ?? 0;
      const textHeight = ascent + descent;

      const padding = config.label_padding ?? 2;
      ctx.fillStyle = config.colors.label_bg;
      ctx.fillRect(
        screenPos.x - padding,
        screenPos.y - ascent - padding,
        metrics.width + padding * 2,
        textHeight + padding * 2
      );

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
    const {
      width,
      height,
      data,
      config,
      maxDistance = 3,
      coursePlot,
    } = currentProps;
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
      maxDistance,
      coursePlot
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
  const { width, height, data, config, maxDistance = 3, coursePlot } = props;

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
    maxDistance,
    coursePlot
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
  const { width, height, data, config, maxDistance = 3, coursePlot } = props;
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
    maxDistance,
    coursePlot
  );
}

/** Animate transition to new sector */
export function updateCurrentSector(
  canvas: HTMLCanvasElement,
  props: MiniMapProps,
  newSectorId: number,
  currentCameraState: CameraState | null
): () => void {
  const { width, height, data, config, maxDistance = 3, coursePlot } = props;

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
    maxDistance,
    coursePlot
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
