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
    label: string;
    label_bg: string;
    grid: string;
    background: string;
    current: string;
    current_outline: string;
  };
  grid_spacing?: number; // Distance between hex centers in pixels (default: auto-calculated)
  hex_size?: number; // Visual radius of each hex in pixels (default: grid_spacing * 0.85)
  sector_label_offset?: number; // Pixel offset for sector ID labels from hex edge (default: 2)
  frame_padding?: number; // Padding around the bounding box when framing (default: 0)
  current_sector_outer_border?: number; // Thickness of outer border for current sector (default: 0, disabled)
  debug?: boolean; // Show debug visualizations (bounding boxes, etc.)
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

export interface CameraState {
  offsetX: number;
  offsetY: number;
  zoom: number;
  filteredData: MiniMapData;
  fadingOutData?: MiniMapData; // Sectors that were visible but are now disconnected
  fadeProgress?: number; // 0 = fully visible, 1 = fully faded
}

interface AnimationState {
  isAnimating: boolean;
  startTime: number;
  duration: number;
  startCamera: CameraState;
  targetCamera: CameraState;
  animationFrameId?: number;
}

/**
 * Easing function for smooth animation (ease-in-out cubic)
 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Interpolate between two camera states
 */
function interpolateCameraState(
  start: CameraState,
  target: CameraState,
  progress: number
): CameraState {
  const easedProgress = easeInOutCubic(progress);
  return {
    offsetX: start.offsetX + (target.offsetX - start.offsetX) * easedProgress,
    offsetY: start.offsetY + (target.offsetY - start.offsetY) * easedProgress,
    zoom: start.zoom + (target.zoom - start.zoom) * easedProgress,
    filteredData: target.filteredData, // Use target data (no interpolation)
    fadingOutData: start.fadingOutData, // Keep fading sectors from start
    fadeProgress: progress, // Current fade progress
  };
}

/**
 * Convert hex grid coordinates (q, r) to world pixel coordinates
 * Uses offset coordinate system matching world_viewer.html
 */
function hexToWorld(
  hexX: number,
  hexY: number,
  scale: number
): { x: number; y: number } {
  const x = scale * 1.5 * hexX;
  const y = scale * Math.sqrt(3) * (hexY + 0.5 * (hexX & 1));
  return { x, y };
}

/**
 * Draw a hexagon outline at the given position
 */
function drawHex(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  fill: boolean = false
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

/**
 * Calculate all sectors reachable from current sector via BFS traversal
 * Returns a Map of sector ID to distance (number of jumps from current)
 */
function calculateReachableSectors(
  data: MiniMapData,
  currentSectorId: number,
  maxDistance: number
): Map<number, number> {
  const reachableMap = new Map<number, number>();
  const currentSector = data[currentSectorId];

  if (!currentSector) return reachableMap;

  // BFS queue: { id, distance }
  const queue: Array<{ id: number; distance: number }> = [
    { id: currentSectorId, distance: 0 },
  ];
  const visited = new Set<number>([currentSectorId]);
  reachableMap.set(currentSectorId, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Stop if we've reached max distance
    if (current.distance >= maxDistance) continue;

    const sector = data[current.id];
    if (!sector) continue;

    // Process all outgoing lanes
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

/**
 * Filter data to only include reachable sectors
 */
function filterReachableSectors(
  data: MiniMapData,
  reachableMap: Map<number, number>
): MiniMapData {
  const filtered: MiniMapData = {};

  reachableMap.forEach((_distance, sectorId) => {
    if (data[sectorId]) {
      filtered[sectorId] = data[sectorId];
    }
  });

  return filtered;
}

/**
 * Calculate sectors that are in oldData but not in newData (for fade-out)
 */
function calculateFadingOutSectors(
  oldData: MiniMapData,
  newData: MiniMapData
): MiniMapData {
  const fadingOut: MiniMapData = {};

  Object.keys(oldData).forEach((sectorIdStr) => {
    const sectorId = parseInt(sectorIdStr, 10);
    if (!newData[sectorId]) {
      fadingOut[sectorId] = oldData[sectorId];
    }
  });

  return fadingOut;
}

/**
 * Calculate bounds of all sectors in world coordinates
 */
function calculateSectorBounds(
  data: MiniMapData,
  scale: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  Object.values(data).forEach((node) => {
    const world = hexToWorld(node.position[0], node.position[1], scale);
    minX = Math.min(minX, world.x);
    minY = Math.min(minY, world.y);
    maxX = Math.max(maxX, world.x);
    maxY = Math.max(maxY, world.y);
  });

  return { minX, minY, maxX, maxY };
}

/**
 * Calculate camera transform to fit and frame all connected sectors optimally
 */
function calculateCameraTransform(
  data: MiniMapData,
  _currentSectorId: number,
  width: number,
  height: number,
  scale: number,
  _hexSize: number,
  framePadding: number = 0
): { offsetX: number; offsetY: number; zoom: number } {
  const bounds = calculateSectorBounds(data, scale);
  const boundsWidth = bounds.maxX - bounds.minX;
  const boundsHeight = bounds.maxY - bounds.minY;

  // Calculate zoom to fit all sectors with configurable padding
  const scaleX = (width - framePadding * 2) / boundsWidth;
  const scaleY = (height - framePadding * 2) / boundsHeight;
  const zoom = Math.min(scaleX, scaleY, 1.5);

  // Center on the center of all connected sectors' bounding box
  // This maximizes use of canvas space
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  return { offsetX: -centerX, offsetY: -centerY, zoom };
}

/**
 * Render debug bounding box (for debugging framing)
 */
function renderDebugBounds(
  ctx: CanvasRenderingContext2D,
  data: MiniMapData,
  scale: number
) {
  const bounds = calculateSectorBounds(data, scale);

  ctx.save();
  ctx.strokeStyle = "#00ff00"; // Green
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]); // Dashed line

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  ctx.strokeRect(bounds.minX, bounds.minY, width, height);

  ctx.restore();
}

/**
 * Render an arrow for one-way lanes
 */
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

/**
 * Calculate intersection point of line with hex boundary
 * Moves from center towards target, stopping at hex edge
 */
function getHexEdgePoint(
  center: { x: number; y: number },
  target: { x: number; y: number },
  hexSize: number
): { x: number; y: number } {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance === 0) return center;

  // Move from center towards target by hexSize distance
  const ratio = hexSize / distance;
  return {
    x: center.x + dx * ratio,
    y: center.y + dy * ratio,
  };
}

/**
 * Render a single lane connecting two sectors
 */
function renderLane(
  ctx: CanvasRenderingContext2D,
  lane: MiniMapLane,
  fromNode: MiniMapNode,
  toNode: MiniMapNode,
  scale: number,
  hexSize: number,
  config: MiniMapRenderConfig
) {
  const fromCenter = hexToWorld(
    fromNode.position[0],
    fromNode.position[1],
    scale
  );
  const toCenter = hexToWorld(toNode.position[0], toNode.position[1], scale);

  // Calculate edge points instead of center points
  const from = getHexEdgePoint(fromCenter, toCenter, hexSize);
  const to = getHexEdgePoint(toCenter, fromCenter, hexSize);

  // Choose color based on lane type
  if (lane.hyperlane && config.show_hyperlanes) {
    ctx.strokeStyle = config.colors.hyperlane;
    ctx.lineWidth = 2;
  } else if (lane.two_way) {
    ctx.strokeStyle = config.colors.lane;
    ctx.lineWidth = 1.5;
  } else {
    ctx.strokeStyle = config.colors.lane_one_way;
    ctx.lineWidth = 1.5;
  }

  // Draw the lane
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  // Draw arrow for one-way lanes
  if (!lane.two_way) {
    renderArrow(ctx, from, to);
  }
}

/**
 * Find an available edge direction that doesn't conflict with existing lanes
 */
function findAvailableEdgeDirection(
  fromNode: MiniMapNode,
  data: MiniMapData,
  scale: number
): number {
  // Calculate angles to all connected sectors
  const usedAngles = fromNode.lanes
    .map((lane) => {
      const toNode = data[lane.to];
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

  // Six possible hex directions (60° apart)
  const hexDirections = [
    0,
    Math.PI / 3,
    (2 * Math.PI) / 3,
    Math.PI,
    (4 * Math.PI) / 3,
    (5 * Math.PI) / 3,
  ];

  // Find first direction that doesn't conflict (at least 45° away from any used angle)
  for (const direction of hexDirections) {
    const isAvailable = usedAngles.every((usedAngle) => {
      let diff = Math.abs(direction - usedAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      return diff > Math.PI / 4; // 45° threshold
    });
    if (isAvailable) return direction;
  }

  // Fallback to right direction
  return 0;
}

/**
 * Render hyperlane stub for destinations outside visible area
 * Returns label info to be rendered later on top of everything
 */
function renderHyperlaneStub(
  ctx: CanvasRenderingContext2D,
  fromNode: MiniMapNode,
  destinationId: number,
  direction: number,
  scale: number,
  hexSize: number,
  config: MiniMapRenderConfig
): { x: number; y: number; text: string } | null {
  const fromWorld = hexToWorld(
    fromNode.position[0],
    fromNode.position[1],
    scale
  );

  // Draw stub extending one hex space in the direction
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

  // Draw the stub lane
  ctx.save();
  ctx.strokeStyle = config.colors.hyperlane;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]); // Dashed to indicate it continues
  ctx.beginPath();
  ctx.moveTo(startEdge.x, startEdge.y);
  ctx.lineTo(endPoint.x, endPoint.y);
  ctx.stroke();
  ctx.restore();

  // Draw arrow at the end
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

  // Return label info to be rendered later (on top of everything)
  return {
    x: endPoint.x + 4,
    y: endPoint.y - 4,
    text: `→${destinationId}`,
  };
}

/**
 * Render all lanes for the visible sectors
 * Returns hyperlane stub label info to be rendered later
 */
function renderAllLanes(
  ctx: CanvasRenderingContext2D,
  data: MiniMapData,
  scale: number,
  hexSize: number,
  config: MiniMapRenderConfig
): Array<{ x: number; y: number; text: string }> {
  const renderedLanes = new Set<string>();
  const hyperlaneLabels: Array<{ x: number; y: number; text: string }> = [];

  Object.values(data).forEach((fromNode) => {
    fromNode.lanes.forEach((lane) => {
      const toNode = data[lane.to];

      if (!toNode) {
        // Destination not visible - if it's a hyperlane, render a stub
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

      // For two-way lanes, only render once (use sorted IDs to create unique key)
      if (lane.two_way) {
        const laneKey = [lane.from, lane.to].sort((a, b) => a - b).join("-");
        if (renderedLanes.has(laneKey)) return;
        renderedLanes.add(laneKey);
      }

      renderLane(ctx, lane, fromNode, toNode, scale, hexSize, config);
    });
  });

  return hyperlaneLabels;
}

/**
 * Apply alpha/opacity to a color string (multiplies existing alpha)
 */
function applyAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  } else if (color.startsWith("rgba")) {
    // Extract existing alpha and multiply with new alpha
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
  } else if (color.startsWith("rgb")) {
    const match = color.match(/rgb\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
    if (match) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
    }
  }
  return color;
}

/**
 * Render a single sector hex
 */
function renderSector(
  ctx: CanvasRenderingContext2D,
  node: MiniMapNode,
  scale: number,
  hexSize: number,
  config: MiniMapRenderConfig,
  currentRegion?: string,
  opacity: number = 1
) {
  const world = hexToWorld(node.position[0], node.position[1], scale);
  const isVisited = node.visited ?? false;
  const isCurrent = node.id === config.current_sector_id;
  const isCrossRegion =
    currentRegion && node.region && node.region !== currentRegion;

  // Draw outer border for current sector if configured
  if (isCurrent && config.current_sector_outer_border) {
    const outerBorderSize = config.current_sector_outer_border;
    ctx.save();
    ctx.strokeStyle = applyAlpha(config.colors.current_outline, opacity);
    ctx.lineWidth = outerBorderSize;
    drawHex(ctx, world.x, world.y, hexSize + outerBorderSize / 2 + 2, false);
    ctx.restore();
  }

  // Set fill color based on visited state
  const fillColor = isVisited ? config.colors.visited : config.colors.empty;
  ctx.fillStyle = applyAlpha(fillColor, opacity);

  // Set border color and width
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

  // Draw the hex
  drawHex(ctx, world.x, world.y, hexSize, true);

  // Draw port indicator if present
  if (config.show_ports && node.port) {
    const isMegaPort = node.port === "MEGA";
    const portColor = isMegaPort ? config.colors.mega_port : config.colors.port;
    ctx.fillStyle = applyAlpha(portColor, opacity);
    ctx.beginPath();
    ctx.arc(world.x, world.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Render hex grid background covering the visible area
 */
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

  // Calculate world bounds visible in the canvas after camera transform
  // Canvas corner to world: (canvas - width/2) / zoom - offset
  const worldLeft = -width / 2 / cameraZoom - cameraOffsetX;
  const worldRight = width / 2 / cameraZoom - cameraOffsetX;
  const worldTop = -height / 2 / cameraZoom - cameraOffsetY;
  const worldBottom = height / 2 / cameraZoom - cameraOffsetY;

  const minHexX = Math.floor(worldLeft / stepX) - 2;
  let maxHexX = Math.ceil(worldRight / stepX) + 2;

  // Safety clamp
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

/**
 * Calculate camera state for given props (reusable for animation)
 */
function calculateCameraState(
  data: MiniMapData,
  config: MiniMapRenderConfig,
  width: number,
  height: number,
  scale: number,
  hexSize: number,
  maxDistance: number
): CameraState | null {
  // Calculate reachable sectors from current sector
  const reachableMap = calculateReachableSectors(
    data,
    config.current_sector_id,
    maxDistance
  );

  // Filter data to only include reachable sectors
  const filteredData = filterReachableSectors(data, reachableMap);

  // If no reachable sectors, return null
  if (Object.keys(filteredData).length === 0) {
    return null;
  }

  // Calculate camera transform to fit and center on current sector
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

/**
 * Convert world coordinates to screen coordinates given camera state
 */
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

/**
 * Render sector labels (fixed size, positioned at top-right of each hex)
 */
function renderSectorLabels(
  ctx: CanvasRenderingContext2D,
  data: MiniMapData,
  scale: number,
  hexSize: number,
  width: number,
  height: number,
  cameraState: CameraState,
  config: MiniMapRenderConfig
) {
  if (!config.show_sector_ids) return;

  ctx.save();
  ctx.font = "8px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const labelOffset = config.sector_label_offset ?? 2;
  const padding = 1; // Padding around text inside background

  Object.values(data).forEach((node) => {
    const worldPos = hexToWorld(node.position[0], node.position[1], scale);

    // Calculate top-right edge of hex in world coordinates
    // Hex vertices are at 60° intervals starting at 0°
    // Top-right vertex is at 300° (-60° or 5π/3)
    const angle = -Math.PI / 3;
    const edgeWorldX = worldPos.x + hexSize * Math.cos(angle);
    const edgeWorldY = worldPos.y + hexSize * Math.sin(angle);

    // Convert to screen coordinates
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

    // Measure text to draw background
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = 8; // Font size

    // Draw background rectangle
    ctx.fillStyle = config.colors.label_bg;
    ctx.fillRect(
      textX - padding,
      textY - padding,
      textWidth + padding * 2,
      textHeight + padding * 2
    );

    // Draw text on top
    ctx.fillStyle = config.colors.label;
    ctx.fillText(text, textX, textY);
  });

  ctx.restore();
}

/**
 * Render port code labels (fixed size, positioned at bottom-right of each hex)
 */
function renderPortLabels(
  ctx: CanvasRenderingContext2D,
  data: MiniMapData,
  scale: number,
  hexSize: number,
  width: number,
  height: number,
  cameraState: CameraState,
  config: MiniMapRenderConfig
) {
  if (!config.show_ports) return;

  ctx.save();
  ctx.font = "8px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const labelOffset = config.sector_label_offset ?? 2;
  const padding = 1; // Padding around text inside background

  Object.values(data).forEach((node) => {
    if (!node.port) return; // Skip sectors without ports

    const worldPos = hexToWorld(node.position[0], node.position[1], scale);

    // Calculate bottom-right edge of hex in world coordinates
    // Hex vertices are at 60° intervals starting at 0°
    // Bottom-right vertex is at 60° (π/3)
    const angle = Math.PI / 3;
    const edgeWorldX = worldPos.x + hexSize * Math.cos(angle);
    const edgeWorldY = worldPos.y + hexSize * Math.sin(angle);

    // Convert to screen coordinates
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

    // Measure text to draw background
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = 8; // Font size

    // Draw background rectangle
    ctx.fillStyle = config.colors.label_bg;
    ctx.fillRect(
      textX - padding,
      textY - padding,
      textWidth + padding * 2,
      textHeight + padding * 2
    );

    // Draw text on top
    ctx.fillStyle = config.colors.label;
    ctx.fillText(text, textX, textY);
  });

  ctx.restore();
}

/**
 * Internal render function that renders with a specific camera state
 */
function renderWithCameraState(
  canvas: HTMLCanvasElement,
  props: MiniMapProps,
  cameraState: CameraState
) {
  const { width, height, config } = props;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Clear and setup canvas
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  // Clear canvas with background color
  ctx.fillStyle = config.colors.background;
  ctx.fillRect(0, 0, width, height);

  // Calculate hex sizing
  const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
  const hexSize = config.hex_size ?? gridSpacing * 0.85;
  const scale = gridSpacing;

  // Apply camera transform (center canvas, then zoom and pan)
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(cameraState.zoom, cameraState.zoom);
  ctx.translate(cameraState.offsetX, cameraState.offsetY);

  // Render background grid
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

  // Render lanes (before sectors so they appear behind)
  // Collect hyperlane labels to render later
  const hyperlaneLabels = config.show_warps
    ? renderAllLanes(ctx, cameraState.filteredData, scale, hexSize, config)
    : [];

  // Get current sector's region for cross-region highlighting
  const currentSector = cameraState.filteredData[config.current_sector_id];
  const currentRegion = currentSector?.region;

  // Render fading out sectors (if any) with reduced opacity
  if (cameraState.fadingOutData && cameraState.fadeProgress !== undefined) {
    const fadeOpacity = 1 - cameraState.fadeProgress; // Fade from 1 to 0
    Object.values(cameraState.fadingOutData).forEach((node) => {
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

  // Render only reachable sectors
  Object.values(cameraState.filteredData).forEach((node) => {
    renderSector(ctx, node, scale, hexSize, config, currentRegion);
  });

  // Render debug bounds if enabled (before restore, so affected by camera transform)
  if (config.debug) {
    renderDebugBounds(ctx, cameraState.filteredData, scale);
  }

  ctx.restore();

  // IMPORTANT: Render ALL labels LAST so they're always on top of everything
  // (after restore, so they're not affected by zoom and always in screen space)

  // Render sector ID labels
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

  // Render port code labels
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

  // Render hyperlane stub labels (converted to screen space)
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

      // Draw background
      ctx.fillStyle = config.colors.label_bg;
      ctx.fillRect(screenPos.x - 1, screenPos.y - 7, metrics.width + 2, 10);

      // Draw text
      ctx.fillStyle = config.colors.label;
      ctx.fillText(label.text, screenPos.x, screenPos.y);
    });
    ctx.restore();
  }
}

/**
 * Main render function for the MiniMap canvas (stateless)
 */
export function renderMiniMapCanvas(
  canvas: HTMLCanvasElement,
  props: MiniMapProps
) {
  const { width, height, data, config, maxDistance = 3 } = props;

  // Calculate hex sizing
  const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
  const hexSize = config.hex_size ?? gridSpacing * 0.85;
  const scale = gridSpacing;

  // Calculate camera state
  const cameraState = calculateCameraState(
    data,
    config,
    width,
    height,
    scale,
    hexSize,
    maxDistance
  );

  // If no reachable sectors, just render empty canvas
  if (!cameraState) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = config.colors.background;
      ctx.fillRect(0, 0, width, height);
    }
    return;
  }

  // Render with calculated camera state
  renderWithCameraState(canvas, props, cameraState);
}

/**
 * Get current camera state for the given props (useful for tracking state)
 */
export function getCurrentCameraState(props: MiniMapProps): CameraState | null {
  const { width, height, data, config, maxDistance = 3 } = props;

  // Calculate hex sizing
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

/**
 * Update current sector with animation
 * Returns a cleanup function to cancel the animation
 */
export function updateCurrentSector(
  canvas: HTMLCanvasElement,
  props: MiniMapProps,
  newSectorId: number,
  currentCameraState: CameraState | null,
  duration: number = 500
): () => void {
  const { width, height, data, config, maxDistance = 3 } = props;

  // Calculate hex sizing
  const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
  const hexSize = config.hex_size ?? gridSpacing * 0.85;
  const scale = gridSpacing;

  // Create new config with updated sector ID
  const newConfig = { ...config, current_sector_id: newSectorId };

  // Calculate target camera state
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
    // If no valid target, just render empty
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = config.colors.background;
      ctx.fillRect(0, 0, width, height);
    }
    return () => {}; // No-op cleanup
  }

  // If no current state, just render target directly
  if (!currentCameraState) {
    renderWithCameraState(
      canvas,
      { ...props, config: newConfig },
      targetCameraState
    );
    return () => {}; // No-op cleanup
  }

  // Calculate sectors that need to fade out (in old but not in new)
  const fadingOutData = calculateFadingOutSectors(
    currentCameraState.filteredData,
    targetCameraState.filteredData
  );

  // Setup animation with fading sectors
  const startCameraWithFade: CameraState = {
    ...currentCameraState,
    fadingOutData,
    fadeProgress: 0,
  };

  const animationState: AnimationState = {
    isAnimating: true,
    startTime: performance.now(),
    duration,
    startCamera: startCameraWithFade,
    targetCamera: targetCameraState,
  };

  // Animation loop
  const animate = (currentTime: number) => {
    if (!animationState.isAnimating) return;

    const elapsed = currentTime - animationState.startTime;
    const progress = Math.min(elapsed / animationState.duration, 1);

    // Interpolate camera state
    const interpolatedCamera = interpolateCameraState(
      animationState.startCamera,
      animationState.targetCamera,
      progress
    );

    // Render with interpolated state
    renderWithCameraState(
      canvas,
      { ...props, config: newConfig },
      interpolatedCamera
    );

    // Continue animation if not complete
    if (progress < 1) {
      animationState.animationFrameId = requestAnimationFrame(animate);
    } else {
      animationState.isAnimating = false;
    }
  };

  // Start animation
  animationState.animationFrameId = requestAnimationFrame(animate);

  // Return cleanup function
  return () => {
    animationState.isAnimating = false;
    if (animationState.animationFrameId !== undefined) {
      cancelAnimationFrame(animationState.animationFrameId);
    }
  };
}
