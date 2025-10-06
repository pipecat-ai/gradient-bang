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
    label: string;
    label_bg: string;
    grid: string;
    background: string;
  };
  grid_spacing?: number; // Distance between hex centers in pixels (default: auto-calculated)
  hex_size?: number; // Visual radius of each hex in pixels (default: grid_spacing * 0.85)
  sector_label_offset?: number; // Pixel offset for sector ID labels from hex edge (default: 2)
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
 * Calculate camera transform to fit all sectors and center on current sector
 */
function calculateCameraTransform(
  data: MiniMapData,
  currentSectorId: number,
  width: number,
  height: number,
  scale: number,
  hexSize: number
): { offsetX: number; offsetY: number; zoom: number } {
  const bounds = calculateSectorBounds(data, scale);
  const boundsWidth = bounds.maxX - bounds.minX;
  const boundsHeight = bounds.maxY - bounds.minY;

  // Calculate zoom to fit all sectors with some padding
  const padding = hexSize * 3;
  const scaleX = (width - padding * 2) / boundsWidth;
  const scaleY = (height - padding * 2) / boundsHeight;
  const zoom = Math.min(scaleX, scaleY, 1.5);

  // Find current sector position
  const currentSector = data[currentSectorId];
  if (!currentSector) {
    // If current sector not found, center on bounds center
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    return { offsetX: -centerX, offsetY: -centerY, zoom };
  }

  // Center on current sector
  const currentWorld = hexToWorld(
    currentSector.position[0],
    currentSector.position[1],
    scale
  );
  return { offsetX: -currentWorld.x, offsetY: -currentWorld.y, zoom };
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
 * Render all lanes for the visible sectors
 */
function renderAllLanes(
  ctx: CanvasRenderingContext2D,
  data: MiniMapData,
  scale: number,
  hexSize: number,
  config: MiniMapRenderConfig
) {
  const renderedLanes = new Set<string>();

  Object.values(data).forEach((fromNode) => {
    fromNode.lanes.forEach((lane) => {
      const toNode = data[lane.to];
      if (!toNode) return; // Skip if target not in filtered data

      // For two-way lanes, only render once (use sorted IDs to create unique key)
      if (lane.two_way) {
        const laneKey = [lane.from, lane.to].sort((a, b) => a - b).join("-");
        if (renderedLanes.has(laneKey)) return;
        renderedLanes.add(laneKey);
      }

      renderLane(ctx, lane, fromNode, toNode, scale, hexSize, config);
    });
  });
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
  currentRegion?: string
) {
  const world = hexToWorld(node.position[0], node.position[1], scale);
  const isVisited = node.visited ?? false;
  const isCurrent = node.id === config.current_sector_id;
  const isCrossRegion =
    currentRegion && node.region && node.region !== currentRegion;

  // Set fill color based on visited state
  ctx.fillStyle = isVisited ? config.colors.visited : config.colors.empty;

  // Set border color and width
  if (isCurrent) {
    ctx.strokeStyle = config.colors.sector_border_current;
    ctx.lineWidth = 2;
  } else if (isCrossRegion) {
    ctx.strokeStyle = config.colors.cross_region_outline;
    ctx.lineWidth = 2;
  } else {
    ctx.strokeStyle = config.colors.sector_border;
    ctx.lineWidth = 1;
  }

  // Draw the hex
  drawHex(ctx, world.x, world.y, hexSize, true);

  // Draw port indicator if present
  if (config.show_ports && node.port) {
    const isMegaPort = node.port === "MEGA";
    ctx.fillStyle = isMegaPort ? config.colors.mega_port : config.colors.port;
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
    hexSize
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
  if (config.show_warps) {
    renderAllLanes(ctx, cameraState.filteredData, scale, hexSize, config);
  }

  // Get current sector's region for cross-region highlighting
  const currentSector = cameraState.filteredData[config.current_sector_id];
  const currentRegion = currentSector?.region;

  // Render only reachable sectors
  Object.values(cameraState.filteredData).forEach((node) => {
    renderSector(ctx, node, scale, hexSize, config, currentRegion);
  });

  ctx.restore();

  // Render sector labels (after restore, so they're not affected by zoom)
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

  // Setup animation
  const animationState: AnimationState = {
    isAnimating: true,
    startTime: performance.now(),
    duration,
    startCamera: currentCameraState,
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
