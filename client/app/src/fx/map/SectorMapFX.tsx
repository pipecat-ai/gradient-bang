export interface SectorMapConfigBase {
    current_sector_id: number;
    grid_spacing: number;
    hex_size: number;
    sector_label_offset: number;
    frame_padding: number;
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
    /** Maximum length (in pixels) for partial lanes to culled sectors. If undefined, lanes extend to the culled sector. */
    partial_lane_max_length?: number;
    nodeStyles: NodeStyles;
    laneStyles: LaneStyles;
    labelStyles: LabelStyles;
    portStyles: PortStyles;
    uiStyles: UIStyles;
}

export interface NodeStyle {
    fill: string;
    border: string;
    borderWidth: number;
    outline: string; // "none" to skip outline
    outlineWidth: number;
}

export interface NodeStyles {
    current: NodeStyle;
    visited: NodeStyle;
    unvisited: NodeStyle;
    muted: NodeStyle;
    coursePlotStart: NodeStyle;
    coursePlotEnd: NodeStyle;
    coursePlotMid: NodeStyle;
    coursePlotPassed: NodeStyle;
    crossRegion: NodeStyle;
}

export const DEFAULT_NODE_STYLES: NodeStyles = {
    current: {
        fill: "rgba(74,144,226,0.4)",
        border: "rgba(74,144,226,1)",
        borderWidth: 2,
        outline: "rgba(74,144,226,0.6)",
        outlineWidth: 4,
    },
    visited: {
        fill: "rgba(0,255,0,0.25)",
        border: "rgba(0,255,0,0.5)",
        borderWidth: 2,
        outline: "none",
        outlineWidth: 0,
    },
    unvisited: {
        fill: "rgba(0,0,0,0.35)",
        border: "rgba(200,200,200,0.7)",
        borderWidth: 2,
        outline: "none",
        outlineWidth: 0,
    },
    muted: {
        fill: "rgba(40,40,40,0.5)",
        border: "rgba(40,40,40,0.5)",
        borderWidth: 1,
        outline: "none",
        outlineWidth: 0,
    },
    coursePlotStart: {
        fill: "rgba(0,220,200,0.35)",
        border: "rgba(0,255,230,0.9)",
        borderWidth: 3,
        outline: "rgba(0,255,230,0.6)",
        outlineWidth: 4,
    },
    coursePlotEnd: {
        fill: "rgba(255,200,0,0.35)",
        border: "rgba(255,220,0,0.9)",
        borderWidth: 3,
        outline: "rgba(255,200,0,0.6)",
        outlineWidth: 4,
    },
    coursePlotMid: {
        fill: "rgba(255,255,255,0.25)",
        border: "rgba(255,255,255,1)",
        borderWidth: 2,
        outline: "none",
        outlineWidth: 0,
    },
    coursePlotPassed: {
        fill: "rgba(100,100,100,0.3)",
        border: "rgba(120,180,170,0.6)",
        borderWidth: 2,
        outline: "none",
        outlineWidth: 0,
    },
    crossRegion: {
        fill: "rgba(0,255,0,0.25)",
        border: "rgba(255,120,120,0.9)",
        borderWidth: 2,
        outline: "none",
        outlineWidth: 0,
    },
};

export interface LaneStyle {
    color: string;
    width: number;
    dashPattern: string; // "none" or "4,4" or "12,8"
    arrowColor: string; // "none" or color for directional arrows
    arrowSize: number;
    shadowBlur: number;
    shadowColor: string; // "none" if no shadow
    lineCap: "butt" | "round" | "square";
}

export interface LaneStyles {
    normal: LaneStyle;
    oneWay: LaneStyle;
    hyperlane: LaneStyle;
    hyperlaneStub: LaneStyle;
    partial: LaneStyle;
    muted: LaneStyle;
    coursePlot: LaneStyle;
    coursePlotAnimation: LaneStyle;
}

export const DEFAULT_LANE_STYLES: LaneStyles = {
    normal: {
        color: "rgba(120,230,160,1)",
        width: 1.5,
        dashPattern: "none",
        arrowColor: "none",
        arrowSize: 0,
        shadowBlur: 0,
        shadowColor: "none",
        lineCap: "round",
    },
    oneWay: {
        color: "#4a90e2",
        width: 1.5,
        dashPattern: "none",
        arrowColor: "#4a90e2",
        arrowSize: 8,
        shadowBlur: 0,
        shadowColor: "none",
        lineCap: "round",
    },
    hyperlane: {
        color: "rgba(190,160,255,1)",
        width: 2,
        dashPattern: "none",
        arrowColor: "none",
        arrowSize: 0,
        shadowBlur: 0,
        shadowColor: "none",
        lineCap: "round",
    },
    hyperlaneStub: {
        color: "rgba(190,160,255,1)",
        width: 2,
        dashPattern: "4,4",
        arrowColor: "rgba(190,160,255,1)",
        arrowSize: 6,
        shadowBlur: 0,
        shadowColor: "none",
        lineCap: "round",
    },
    partial: {
        color: "rgba(120,230,160,1)",
        width: 1.5,
        dashPattern: "3,3",
        arrowColor: "rgba(120,230,160,1)",
        arrowSize: 8,
        shadowBlur: 0,
        shadowColor: "none",
        lineCap: "round",
    },
    muted: {
        color: "rgba(80,80,80,0.4)",
        width: 1.5,
        dashPattern: "none",
        arrowColor: "rgba(80,80,80,0.4)",
        arrowSize: 8,
        shadowBlur: 0,
        shadowColor: "none",
        lineCap: "round",
    },
    coursePlot: {
        color: "rgba(120,230,160,1)",
        width: 4,
        dashPattern: "none",
        arrowColor: "rgba(120,230,160,1)",
        arrowSize: 8,
        shadowBlur: 0,
        shadowColor: "none",
        lineCap: "round",
    },
    coursePlotAnimation: {
        color: "rgba(255,255,255,0.6)",
        width: 4,
        dashPattern: "12,8",
        arrowColor: "none",
        arrowSize: 0,
        shadowBlur: 0,
        shadowColor: "rgba(255,255,255,0.8)",
        lineCap: "butt",
    },
};

export interface LabelStyle {
    textColor: string;
    backgroundColor: string;
    padding: number;
    fontSize: number;
    fontWeight: number | string;
    mutedOpacity: number;
}

export interface LabelStyles {
    sectorId: LabelStyle;
    portCode: LabelStyle;
    hyperlane: LabelStyle;
}

export const DEFAULT_LABEL_STYLES: LabelStyles = {
    sectorId: {
        textColor: "#000000",
        backgroundColor: "#ffffff",
        padding: 2,
        fontSize: 10,
        fontWeight: 800,
        mutedOpacity: 0.3,
    },
    portCode: {
        textColor: "#000000",
        backgroundColor: "#ffffff",
        padding: 2,
        fontSize: 10,
        fontWeight: 800,
        mutedOpacity: 0.3,
    },
    hyperlane: {
        textColor: "#000000",
        backgroundColor: "#ffffff",
        padding: 2,
        fontSize: 10,
        fontWeight: 800,
        mutedOpacity: 1,
    },
};

export interface PortStyle {
    color: string;
    radius: number;
    mutedColor: string;
}

export interface PortStyles {
    regular: PortStyle;
    mega: PortStyle;
}

export const DEFAULT_PORT_STYLES: PortStyles = {
    regular: {
        color: "#FFFFFF",
        radius: 5,
        mutedColor: "rgba(40,40,40,0.5)",
    },
    mega: {
        color: "#ffd700",
        radius: 5,
        mutedColor: "rgba(40,40,40,0.5)",
    },
};

export interface UIStyles {
    grid: {
        color: string;
        lineWidth: number;
    };
    background: {
        color: string;
    };
    edgeFeather: {
        size: number;
    };
}

export const DEFAULT_UI_STYLES: UIStyles = {
    grid: {
        color: "rgba(255,255,255,0.3)",
        lineWidth: 1,
    },
    background: {
        color: "#000000",
    },
    edgeFeather: {
        size: 220,
    },
};

export const DEFAULT_SECTORMAP_CONFIG: Omit<
    SectorMapConfigBase,
    "current_sector_id"
> = {
    grid_spacing: 30,
    hex_size: 20,
    sector_label_offset: 5,
    frame_padding: 40,
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
    partial_lane_max_length: 40,
    nodeStyles: DEFAULT_NODE_STYLES,
    laneStyles: DEFAULT_LANE_STYLES,
    labelStyles: DEFAULT_LABEL_STYLES,
    portStyles: DEFAULT_PORT_STYLES,
    uiStyles: DEFAULT_UI_STYLES,
};

export interface SectorMapProps {
    width: number;
    height: number;
    data: MapData;
    config: SectorMapConfigBase;
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
    config: SectorMapConfigBase,
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

    // Determine lane type priority
    const isInPlot = coursePlotLanes
        ? coursePlotLanes.has(getUndirectedLaneKey(fromNode.id, toNode.id))
        : true;

    let laneStyle: LaneStyle;
    if (coursePlotLanes && !isInPlot) {
        laneStyle = config.laneStyles.muted;
    } else if (coursePlot && isInPlot) {
        laneStyle = config.laneStyles.coursePlot;
    } else if (lane.hyperlane && config.show_hyperlanes) {
        laneStyle = config.laneStyles.hyperlane;
    } else if (isBidirectional) {
        laneStyle = config.laneStyles.normal;
    } else {
        laneStyle = config.laneStyles.oneWay;
    }

    // Apply lane style
    ctx.strokeStyle = laneStyle.color;
    ctx.lineWidth = laneStyle.width;
    ctx.lineCap = laneStyle.lineCap;
    if (laneStyle.dashPattern !== "none") {
        ctx.setLineDash(laneStyle.dashPattern.split(",").map((n) => parseFloat(n)));
    } else {
        ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Determine if arrow is needed
    let needsArrow = laneStyle.arrowColor !== "none" && laneStyle.arrowSize > 0;
    let arrowFrom = from;
    let arrowTo = to;

    if (coursePlot && isInPlot) {
        const fromIndex = coursePlot.path.indexOf(fromNode.id);
        const toIndex = coursePlot.path.indexOf(toNode.id);

        if (
            fromIndex !== -1 &&
            toIndex !== -1 &&
            Math.abs(fromIndex - toIndex) === 1
        ) {
            needsArrow = true;
            if (fromIndex < toIndex) {
                arrowFrom = from;
                arrowTo = to;
            } else {
                arrowFrom = to;
                arrowTo = from;
            }
        }
    }

    if (needsArrow) {
        ctx.strokeStyle = laneStyle.arrowColor;
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
    config: SectorMapConfigBase
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

    const stubStyle = config.laneStyles.hyperlaneStub;

    ctx.save();
    ctx.strokeStyle = stubStyle.color;
    ctx.lineWidth = stubStyle.width;
    ctx.lineCap = stubStyle.lineCap;
    if (stubStyle.dashPattern !== "none") {
        ctx.setLineDash(stubStyle.dashPattern.split(",").map((n) => parseFloat(n)));
    }
    ctx.beginPath();
    ctx.moveTo(startEdge.x, startEdge.y);
    ctx.lineTo(endPoint.x, endPoint.y);
    ctx.stroke();
    ctx.restore();

    if (stubStyle.arrowColor !== "none" && stubStyle.arrowSize > 0) {
        ctx.save();
        ctx.strokeStyle = stubStyle.arrowColor;
        ctx.fillStyle = stubStyle.arrowColor;
        ctx.lineWidth = stubStyle.width;
        const arrowSize = stubStyle.arrowSize;
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
    }

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
    config: SectorMapConfigBase,
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
    let to = getHexEdgePoint(toCenter, fromCenter, hexSize);

    // Clamp the lane length if max length is configured
    if (config.partial_lane_max_length !== undefined) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > config.partial_lane_max_length) {
            const ratio = config.partial_lane_max_length / distance;
            to = {
                x: from.x + dx * ratio,
                y: from.y + dy * ratio,
            };
        }
    }

    // Determine which style to use
    const isInPlot = coursePlotLanes
        ? coursePlotLanes.has(getUndirectedLaneKey(fromNode.id, culledToNode.id))
        : true;

    const laneStyle =
        coursePlotLanes && !isInPlot
            ? config.laneStyles.muted
            : coursePlot && isInPlot
                ? config.laneStyles.coursePlot
                : config.laneStyles.partial;

    ctx.save();

    // Create gradient that fades out towards the end
    const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
    gradient.addColorStop(0, laneStyle.color);
    gradient.addColorStop(0.7, laneStyle.color);
    gradient.addColorStop(1, applyAlpha(laneStyle.color, 0));

    ctx.strokeStyle = gradient;
    ctx.lineWidth = laneStyle.width;
    ctx.lineCap = laneStyle.lineCap;
    if (laneStyle.dashPattern !== "none") {
        ctx.setLineDash(laneStyle.dashPattern.split(",").map((n) => parseFloat(n)));
    }

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Add arrow for partial lanes if style specifies
    if (
        laneStyle.arrowColor !== "none" &&
        laneStyle.arrowSize > 0 &&
        coursePlot &&
        isInPlot
    ) {
        const fromIndex = coursePlot.path.indexOf(fromNode.id);
        const toIndex = coursePlot.path.indexOf(culledToNode.id);

        if (
            fromIndex !== -1 &&
            toIndex !== -1 &&
            Math.abs(fromIndex - toIndex) === 1
        ) {
            const arrowFrom = fromIndex < toIndex ? from : to;
            const arrowTo = fromIndex < toIndex ? to : from;
            ctx.strokeStyle = laneStyle.arrowColor;
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
    config: SectorMapConfigBase,
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
            return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${existingAlpha * alpha
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
    config: SectorMapConfigBase,
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

    const finalOpacity = opacity;
    const isInPlot = coursePlotSectors ? coursePlotSectors.has(node.id) : true;

    // Determine node type priority
    let nodeStyle: NodeStyle;
    if (coursePlot && isInPlot) {
        const currentIndex = coursePlot.path.indexOf(config.current_sector_id);
        const nodeIndex = coursePlot.path.indexOf(node.id);

        if (node.id === config.current_sector_id && nodeIndex !== -1) {
            // Player is at this node in the course
            nodeStyle = config.nodeStyles.coursePlotStart;
        } else if (node.id === coursePlot.to_sector) {
            // Final destination
            nodeStyle = config.nodeStyles.coursePlotEnd;
        } else if (
            nodeIndex !== -1 &&
            currentIndex !== -1 &&
            nodeIndex < currentIndex
        ) {
            // Node is behind current position in course
            nodeStyle = config.nodeStyles.coursePlotPassed;
        } else if (nodeIndex !== -1) {
            // Node is ahead in course
            nodeStyle = config.nodeStyles.coursePlotMid;
        } else {
            // Fallback for nodes in plot set but not in path (shouldn't happen)
            nodeStyle = config.nodeStyles.coursePlotMid;
        }
    } else if (coursePlotSectors && !isInPlot) {
        nodeStyle = config.nodeStyles.muted;
    } else if (isCurrent) {
        nodeStyle = config.nodeStyles.current;
    } else if (isCrossRegion) {
        nodeStyle = config.nodeStyles.crossRegion;
    } else if (isVisited) {
        nodeStyle = config.nodeStyles.visited;
    } else {
        nodeStyle = config.nodeStyles.unvisited;
    }

    // Render outline if specified
    if (nodeStyle.outline !== "none" && nodeStyle.outlineWidth > 0) {
        ctx.save();
        ctx.strokeStyle = applyAlpha(nodeStyle.outline, finalOpacity);
        ctx.lineWidth = nodeStyle.outlineWidth;
        drawHex(
            ctx,
            world.x,
            world.y,
            hexSize + nodeStyle.outlineWidth / 2 + 2,
            false
        );
        ctx.restore();
    }

    // Render fill and border
    ctx.fillStyle = applyAlpha(nodeStyle.fill, finalOpacity);
    ctx.strokeStyle = applyAlpha(nodeStyle.border, finalOpacity);
    ctx.lineWidth = nodeStyle.borderWidth;

    drawHex(ctx, world.x, world.y, hexSize, true);

    if (config.show_ports && node.port) {
        const isMegaPort = node.is_mega || node.id === 0;
        const portStyle = isMegaPort
            ? config.portStyles.mega
            : config.portStyles.regular;

        // Use muted color for ports not in course plot
        let portColor: string;
        if (coursePlotSectors && !isInPlot) {
            portColor = portStyle.mutedColor;
        } else {
            portColor = portStyle.color;
        }

        ctx.fillStyle = applyAlpha(portColor, finalOpacity);
        ctx.beginPath();
        ctx.arc(world.x, world.y, portStyle.radius, 0, Math.PI * 2);
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
    gridStyle: { color: string; lineWidth: number }
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
    ctx.strokeStyle = gridStyle.color;
    ctx.lineWidth = gridStyle.lineWidth;

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
    config: SectorMapConfigBase,
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
    config: SectorMapConfigBase,
    coursePlotSectors: Set<number> | null = null
) {
    if (!config.show_sector_ids) return;

    const labelStyle = config.labelStyles.sectorId;

    ctx.save();
    ctx.font = `${labelStyle.fontWeight} ${labelStyle.fontSize
        }px ${getCanvasFontFamily(ctx)}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    const labelOffset = config.sector_label_offset ?? 2;
    const padding = labelStyle.padding;

    data.forEach((node) => {
        // Skip labels for current sector
        if (node.id === config.current_sector_id) return;

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
            labelStyle.fontSize;
        const descent =
            metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 0;
        const textHeight = ascent + descent;

        // Apply muted opacity to labels for sectors not in course plot
        const labelOpacity =
            coursePlotSectors && !coursePlotSectors.has(node.id)
                ? labelStyle.mutedOpacity
                : 1;

        ctx.fillStyle = applyAlpha(labelStyle.backgroundColor, labelOpacity);
        ctx.fillRect(
            textX - padding,
            textY - ascent - padding,
            textWidth + padding * 2,
            textHeight + padding * 2
        );

        ctx.fillStyle = applyAlpha(labelStyle.textColor, labelOpacity);
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
    config: SectorMapConfigBase,
    coursePlotSectors: Set<number> | null = null
) {
    if (!config.show_ports) return;

    const labelStyle = config.labelStyles.portCode;

    ctx.save();
    ctx.font = `${labelStyle.fontWeight} ${labelStyle.fontSize
        }px ${getCanvasFontFamily(ctx)}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    const labelOffset = config.sector_label_offset ?? 2;
    const padding = labelStyle.padding;

    data.forEach((node) => {
        if (!node.port) return;
        // Skip labels for current sector
        if (node.id === config.current_sector_id) return;

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
            labelStyle.fontSize;
        const descent =
            metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 0;
        const textHeight = ascent + descent;

        // Apply muted opacity to labels for sectors not in course plot
        const labelOpacity =
            coursePlotSectors && !coursePlotSectors.has(node.id)
                ? labelStyle.mutedOpacity
                : 1;

        ctx.fillStyle = applyAlpha(labelStyle.backgroundColor, labelOpacity);
        ctx.fillRect(
            textX - padding,
            textY - ascent - padding,
            textWidth + padding * 2,
            textHeight + padding * 2
        );

        ctx.fillStyle = applyAlpha(labelStyle.textColor, labelOpacity);
        ctx.fillText(text, textX, textY);
    });

    ctx.restore();
}

/** Core rendering with explicit camera state */
function renderWithCameraState(
    canvas: HTMLCanvasElement,
    props: SectorMapProps,
    cameraState: CameraState
) {
    const { width, height, config, coursePlot } = props;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = config.uiStyles.background.color;
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
            config.uiStyles.grid
        );
    }
    ctx.restore();

    // 2) Apply rectangular feather mask to background + grid (screen space)
    const featherSize = Math.min(
        config.uiStyles.edgeFeather.size,
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
        const labelStyle = config.labelStyles.hyperlane;

        ctx.save();
        ctx.font = `${labelStyle.fontWeight} ${labelStyle.fontSize
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
            const ascent = metrics.actualBoundingBoxAscent ?? labelStyle.fontSize;
            const descent = metrics.actualBoundingBoxDescent ?? 0;
            const textHeight = ascent + descent;

            const padding = labelStyle.padding;
            ctx.fillStyle = labelStyle.backgroundColor;
            ctx.fillRect(
                screenPos.x - padding,
                screenPos.y - ascent - padding,
                metrics.width + padding * 2,
                textHeight + padding * 2
            );

            ctx.fillStyle = labelStyle.textColor;
            ctx.fillText(label.text, screenPos.x, screenPos.y);
        });
        ctx.restore();
    }
}

/** Render animated arrows on course plot lanes only */
function renderCoursePlotAnimation(
    canvas: HTMLCanvasElement,
    props: SectorMapProps,
    cameraState: CameraState,
    animationOffset: number
) {
    const { width, height, config, coursePlot } = props;
    if (!coursePlot) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10;
    const hexSize = config.hex_size ?? gridSpacing * 0.85;
    const scale = gridSpacing;

    const sectorIndex = createSectorIndex(cameraState.filteredData);

    const animStyle = config.laneStyles.coursePlotAnimation;

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(cameraState.zoom, cameraState.zoom);
    ctx.translate(cameraState.offsetX, cameraState.offsetY);

    // Draw animated dashes on course plot lanes
    if (animStyle.shadowBlur > 0 && animStyle.shadowColor !== "none") {
        ctx.shadowBlur = animStyle.shadowBlur;
        ctx.shadowColor = animStyle.shadowColor;
    }
    ctx.strokeStyle = animStyle.color;
    ctx.lineWidth = animStyle.width;
    ctx.lineCap = animStyle.lineCap;
    if (animStyle.dashPattern !== "none") {
        ctx.setLineDash(animStyle.dashPattern.split(",").map((n) => parseFloat(n)));
    }
    ctx.lineDashOffset = -animationOffset;

    for (let i = 0; i < coursePlot.path.length - 1; i++) {
        const fromId = coursePlot.path[i];
        const toId = coursePlot.path[i + 1];

        const fromNode = sectorIndex.get(fromId);
        const toNode = sectorIndex.get(toId);

        if (!fromNode || !toNode) continue;

        const fromCenter = hexToWorld(
            fromNode.position[0],
            fromNode.position[1],
            scale
        );
        const toCenter = hexToWorld(toNode.position[0], toNode.position[1], scale);

        const from = getHexEdgePoint(fromCenter, toCenter, hexSize);
        const to = getHexEdgePoint(toCenter, fromCenter, hexSize);

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
    }

    ctx.restore();
}

export interface SectorMapController {
    render: () => void;
    moveToSector: (newSectorId: number, newMapData?: MapData) => void;
    getCurrentState: () => CameraState | null;
    updateProps: (newProps: Partial<SectorMapProps>) => void;
    startCourseAnimation: () => void;
    stopCourseAnimation: () => void;
}

/** Create minimap controller with imperative API */
export function createSectorMapController(
    canvas: HTMLCanvasElement,
    props: SectorMapProps
): SectorMapController {
    let currentCameraState: CameraState | null = null;
    let currentProps = { ...props };
    let animationCleanup: (() => void) | null = null;
    let animationCompletionTimeout: number | null = null;
    let courseAnimationFrameId: number | null = null;
    let courseAnimationOffset = 0;

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
                ctx.fillStyle = config.uiStyles.background.color;
                ctx.fillRect(0, 0, width, height);
                const feather = Math.min(
                    config.uiStyles.edgeFeather.size,
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

        // Temporarily stop course animation during transition
        const wasAnimating = courseAnimationFrameId !== null;
        if (wasAnimating) {
            stopCourseAnimation();
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
                // Restart course animation if it was running
                if (wasAnimating && updatedProps.coursePlot) {
                    startCourseAnimation();
                }
            }, animDuration);
        } else {
            render();
            // Restart course animation immediately if no camera animation
            if (wasAnimating && updatedProps.coursePlot) {
                startCourseAnimation();
            }
        }
    };

    const getCurrentState = () => currentCameraState;

    const updateProps = (newProps: Partial<SectorMapProps>) => {
        const hadCoursePlot =
            currentProps.coursePlot !== undefined && currentProps.coursePlot !== null;
        const hasCoursePlot =
            newProps.coursePlot !== undefined && newProps.coursePlot !== null;

        Object.assign(currentProps, newProps);
        if (newProps.config) {
            Object.assign(currentProps.config, newProps.config);
        }

        // Start or stop animation based on coursePlot presence
        if (hasCoursePlot && !hadCoursePlot) {
            startCourseAnimation();
        } else if (!hasCoursePlot && hadCoursePlot) {
            stopCourseAnimation();
        }
    };

    const startCourseAnimation = () => {
        if (courseAnimationFrameId !== null) return; // Already running
        if (!currentProps.coursePlot || !currentCameraState) return;

        const animate = () => {
            courseAnimationOffset = (courseAnimationOffset + 0.5) % 20; // Cycle through dash pattern smoothly

            if (currentCameraState && currentProps.coursePlot) {
                // Re-render the base map first to clear previous animation frame
                render();
                // Then draw animated dashes on top
                renderCoursePlotAnimation(
                    canvas,
                    currentProps,
                    currentCameraState,
                    courseAnimationOffset
                );
            }

            courseAnimationFrameId = requestAnimationFrame(animate);
        };

        courseAnimationFrameId = requestAnimationFrame(animate);
    };

    const stopCourseAnimation = () => {
        if (courseAnimationFrameId !== null) {
            cancelAnimationFrame(courseAnimationFrameId);
            courseAnimationFrameId = null;
            courseAnimationOffset = 0;
        }
    };

    render();

    // Start animation if coursePlot is already active
    if (props.coursePlot) {
        startCourseAnimation();
    }

    return {
        render,
        moveToSector,
        getCurrentState,
        updateProps,
        startCourseAnimation,
        stopCourseAnimation,
    };
}

/** Render minimap canvas (stateless) */
export function renderSectorMapCanvas(
    canvas: HTMLCanvasElement,
    props: SectorMapProps
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
            ctx.fillStyle = config.uiStyles.background.color;
            ctx.fillRect(0, 0, width, height);
            const feather = Math.min(
                config.uiStyles.edgeFeather.size,
                Math.min(width, height) / 2
            );
            applyRectangularFeatherMask(ctx, width, height, feather);
        }
        return;
    }

    renderWithCameraState(canvas, props, cameraState);
}

/** Get current camera state for tracking between renders */
export function getCurrentCameraState(props: SectorMapProps): CameraState | null {
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
    props: SectorMapProps,
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
            ctx.fillStyle = config.uiStyles.background.color;
            ctx.fillRect(0, 0, width, height);
            const feather = Math.min(
                config.uiStyles.edgeFeather.size,
                Math.min(width, height) / 2
            );
            applyRectangularFeatherMask(ctx, width, height, feather);
        }
        return () => { };
    }

    if (!currentCameraState || config.bypass_animation) {
        renderWithCameraState(
            canvas,
            { ...props, config: newConfig },
            targetCameraState
        );
        return () => { };
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
