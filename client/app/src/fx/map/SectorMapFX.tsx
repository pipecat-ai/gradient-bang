import { isBorderSector } from "@/utils/map"
import { getPortCode } from "@/utils/port"

import { GARRISON_ICON, MEGA_PORT_ICON, PORT_ICON, SHIP_ICON } from "./MapIcons"

import { DEFAULT_MAX_BOUNDS } from "@/types/constants"

// Create Path2D once at module level for performance
const portPath = new Path2D(PORT_ICON)
const megaPortPath = new Path2D(MEGA_PORT_ICON)
const shipPath = new Path2D(SHIP_ICON)
const garrisonPath = new Path2D(GARRISON_ICON)
const PORT_ICON_VIEWBOX = 256
const SHIP_ICON_VIEWBOX = 256
const GARRISON_ICON_VIEWBOX = 256

// Minimum lane length (in pixels) to render arrow heads on course plot lanes
// Short lanes look cluttered with arrows
const MIN_LANE_LENGTH_FOR_ARROWS = 30

// Opacity multiplier for nodes not in the active course plot path
const COURSE_PLOT_INACTIVE_NODE_OPACITY = 0.6

export interface SectorMapConfigBase {
  center_sector_id: number
  current_sector_id?: number
  /** Optional world-coordinate center override (zoomMode). When set, camera centers here instead of on center_sector_id. */
  center_world?: [number, number]
  /** Optional world-coordinate bounding box override (zoomMode). When set, camera zooms to fit these bounds. */
  fit_bounds_world?: [number, number, number, number]
  /** Camera mode. `viewport_rect` uses rectangular extents for the large map panel. */
  camera_viewport_mode?: "default" | "viewport_rect"
  /** Whether to visually emphasize the camera center sector. */
  highlight_center_sector?: boolean
  grid_spacing: number
  hex_size: number
  sector_label_offset: number
  frame_padding: number
  animation_duration_pan: number
  animation_duration_zoom: number
  bypass_animation: boolean
  debug: boolean
  show_grid: boolean
  show_warps: boolean
  show_sector_ids: boolean
  show_sector_ids_hover: boolean
  show_ports: boolean
  show_port_labels: boolean
  show_partial_lanes: boolean
  partial_lane_max_length?: number
  clickable: boolean
  hoverable: boolean
  draggable: boolean
  scrollZoom: boolean
  minZoom?: number
  maxZoom?: number
  hover_scale_factor?: number
  hover_animation_duration?: number
  current_sector_scale?: number
  nodeStyles: NodeStyles
  laneStyles: LaneStyles
  labelStyles: LabelStyles
  portStyles: PortStyles
  uiStyles: UIStyles
  regionStyles?: RegionStyleOverrides
  regionLaneStyles?: RegionLaneStyleOverrides
  /** When false, course plots render but the camera does not reframe to fit them. Default true. */
  coursePlotZoomEnabled?: boolean
}

export interface NodeStyle {
  fill: string
  border: string
  borderWidth: number
  borderStyle: "solid" | "dashed" | "dotted"
  borderPosition?: "center" | "inside"
  borderInset?: number
  // Inset border - a second border drawn inside the hex
  insetBorder?: string
  insetBorderWidth?: number
  insetBorderOffset?: number
  outline: string
  outlineWidth: number
  // Port/icon fill color (overrides PortStyles color when set)
  iconColor?: string
  // Offset frame - larger outer ring around the node
  offset?: boolean
  offsetColor?: string
  offsetSize?: number
  offsetWeight?: number
  // Glow - radial gradient behind the node
  glow?: boolean
  glowRadius?: number
  glowColor?: string
  glowFalloff?: number // 0-1, where the color starts to fade (0 = immediate fade, 1 = solid then sharp edge)
  // Split fill/border - diagonal split with second color (bottom-right half)
  splitFill?: string
  splitBorder?: string
}

// Map of slugified region names to partial style overrides
export type RegionStyleOverrides = Record<string, Partial<NodeStyle>>

// Region lane style overrides with separate one-way and two-way colors
export interface RegionLaneStyle {
  twoWayColor?: string
  oneWayColor?: string
  twoWayArrowColor?: string
  oneWayArrowColor?: string
}
export type RegionLaneStyleOverrides = Record<string, RegionLaneStyle>

export interface NodeStyles {
  current: NodeStyle
  corpMember: NodeStyle
  visited: NodeStyle
  visited_corp: NodeStyle
  unvisited: NodeStyle
  muted: NodeStyle
  megaPort: NodeStyle
  garrison: NodeStyle
  coursePlotCurrent: NodeStyle
  coursePlotStart: NodeStyle
  coursePlotEnd: NodeStyle
  coursePlotMid: NodeStyle
  coursePlotPassed: NodeStyle
  hovered: Partial<NodeStyle>
  centered: Partial<NodeStyle>
}

export const DEFAULT_NODE_STYLES: NodeStyles = {
  current: {
    fill: "rgba(8,47,73,0.8)",
    border: "rgba(116,212,255,1)",
    borderWidth: 4,
    borderStyle: "solid",
    borderPosition: "inside",
    outline: "rgba(56,189,248,0.6)",
    outlineWidth: 3,
    iconColor: "#ffffff",
    offset: false,
    offsetColor: "rgba(255,255,255,0.5)",
    offsetSize: 30,
    offsetWeight: 2,
    glow: false,
    glowRadius: 90,
    glowColor: "rgba(116,212,255,0.2)",
    glowFalloff: 0.6,
  },
  corpMember: {
    fill: "rgba(0,0,0,0)",
    border: "rgba(0,0,0,0)",
    borderWidth: 0,
    borderStyle: "solid",
    outline: "none",
    outlineWidth: 0,
    glow: true,
    glowRadius: 90,
    glowColor: "rgba(168,85,247,0.35)",
    glowFalloff: 0.5,
  },
  visited: {
    fill: "rgba(0,255,0,0.25)",
    border: "rgba(0,255,0,1)",
    borderWidth: 2,
    borderStyle: "solid",
    outline: "none",
    outlineWidth: 0,
  },
  visited_corp: {
    fill: "rgba(0,255,0,0.10)",
    border: "rgba(0,255,0,1)",
    borderWidth: 2,
    borderStyle: "dotted",
    outline: "none",
    outlineWidth: 0,
  },
  unvisited: {
    fill: "rgba(0,0,0,0.35)",
    border: "rgba(180,180,180,1)",
    borderWidth: 2,
    borderStyle: "solid",
    outline: "none",
    outlineWidth: 0,
  },
  muted: {
    fill: "rgba(255,255,255,0.1)",
    border: "rgba(255,255,255,0.3)",
    borderWidth: 1,
    borderStyle: "solid",
    outline: "none",
    outlineWidth: 0,
  },
  megaPort: {
    fill: "rgba(255,215,0,0.3)",
    border: "rgba(255,215,0,1)",
    borderWidth: 3,
    borderStyle: "solid",
    outline: "rgba(255,215,0,0.5)",
    outlineWidth: 2,
    iconColor: "#fef9c3",
    glow: true,
    glowRadius: 100,
    glowColor: "rgba(255,255,255,0.15)",
    glowFalloff: 0.3,
  },
  garrison: {
    fill: "rgba(70,8,9,0.8)",
    border: "rgba(239,68,68,1)",
    borderWidth: 3,
    borderStyle: "solid",
    outline: "rgba(239,68,68,0.5)",
    outlineWidth: 2,
    iconColor: "#fecaca",
    glow: true,
    glowRadius: 100,
    glowColor: "rgba(239,68,68,0.2)",
    glowFalloff: 0.3,
  },
  coursePlotCurrent: {
    fill: "rgba(74,144,226,0.4)",
    border: "rgba(74,144,226,1)",
    borderWidth: 4,
    borderStyle: "solid",
    borderPosition: "inside",
    outline: "rgba(74,144,226,0.6)",
    outlineWidth: 3,
    glow: true,
    glowRadius: 100,
    glowColor: "rgba(74,144,226,0.15)",
    glowFalloff: 0.3,
  },
  coursePlotStart: {
    fill: "rgba(0,220,200,0.35)",
    border: "rgba(0,255,230,0.9)",
    borderWidth: 3,
    borderStyle: "solid",
    outline: "rgba(0,255,230,0.6)",
    outlineWidth: 4,
  },
  coursePlotEnd: {
    fill: "rgba(255,200,0,0.35)",
    border: "rgba(255,220,0,0.9)",
    borderWidth: 3,
    borderStyle: "solid",
    outline: "rgba(255,200,0,0.6)",
    outlineWidth: 4,
  },
  coursePlotMid: {
    fill: "rgba(255,255,255,0.25)",
    border: "rgba(255,255,255,1)",
    borderWidth: 2,
    borderStyle: "solid",
    outline: "none",
    outlineWidth: 0,
  },
  coursePlotPassed: {
    fill: "rgba(0,201,80,0.3)",
    border: "rgba(0,201,80,1)",
    borderWidth: 2,
    borderStyle: "solid",
    outline: "none",
    outlineWidth: 0,
  },
  hovered: {
    outlineWidth: 4,
  },
  centered: {
    outline: "rgba(255,200,0,0.6)",
    outlineWidth: 5,
    border: "rgba(255,200,0,1)",
    borderPosition: "inside",
    borderWidth: 3,
    fill: "rgba(255,200,0,0.4)",
  },
}

export const DEFAULT_REGION_STYLES: RegionStyleOverrides = {
  "federation-space": {
    fill: "#042f2e",
    border: "#5eead4",
    outline: "rgba(94,234,212,0.5)",
    iconColor: "#d1fae5",
  },
  neutral: {
    fill: "#1e1b4b",
    border: "#818cf8",
    outline: "rgba(99,102,241,0.5)",
    iconColor: "#e0e7ff",
  },
  "neutral-border": {
    fill: "#1e1b4b",
    splitFill: "#042f2e",
    border: "#818cf8",
    splitBorder: "#5eead4",
    outline: "rgba(99,102,241,0.5)",
    iconColor: "#e0e7ff",
  },
}

export const DEFAULT_REGION_LANE_STYLES: RegionLaneStyleOverrides = {
  "federation-space": {
    twoWayColor: "#99f6e4",
    oneWayColor: "#0d9488",
    twoWayArrowColor: "#99f6e4",
    oneWayArrowColor: "#0d9488",
  },
  neutral: {
    twoWayColor: "#818cf8",
    oneWayColor: "#6366f1",
    twoWayArrowColor: "#818cf8",
    oneWayArrowColor: "#6366f1",
  },
}

export interface LaneStyle {
  color: string
  width: number
  dashPattern: string // "none" or "4,4" or "12,8"
  arrowColor: string // "none" or color for directional arrows
  arrowSize: number
  shadowBlur: number
  shadowColor: string // "none" if no shadow
  lineCap: "butt" | "round" | "square"
}

export interface LaneStyles {
  normal: LaneStyle
  oneWay: LaneStyle
  partial: LaneStyle
  muted: LaneStyle
  coursePlot: LaneStyle
  coursePlotAnimation: LaneStyle
}

export const DEFAULT_LANE_STYLES: LaneStyles = {
  normal: {
    color: "#a3a3a3",
    width: 1.5,
    dashPattern: "none",
    arrowColor: "none",
    arrowSize: 0,
    shadowBlur: 0,
    shadowColor: "none",
    lineCap: "butt",
  },
  oneWay: {
    color: "#737373",
    width: 1.5,
    dashPattern: "none",
    arrowColor: "#737373",
    arrowSize: 8,
    shadowBlur: 0,
    shadowColor: "none",
    lineCap: "butt",
  },
  partial: {
    color: "rgba(120,230,160,1)",
    width: 1.5,
    dashPattern: "3,3",
    arrowColor: "rgba(120,230,160,1)",
    arrowSize: 8,
    shadowBlur: 0,
    shadowColor: "none",
    lineCap: "butt",
  },
  muted: {
    color: "rgba(255,255,255,0.5)",
    width: 1.5,
    dashPattern: "none",
    arrowColor: "rgba(255,255,255,0.5)",
    arrowSize: 8,
    shadowBlur: 0,
    shadowColor: "none",
    lineCap: "butt",
  },
  coursePlot: {
    color: "#059669",
    width: 4,
    dashPattern: "none",
    arrowColor: "#059669",
    arrowSize: 12,
    shadowBlur: 0,
    shadowColor: "#059669",
    lineCap: "butt",
  },
  coursePlotAnimation: {
    color: "#a7f3d0",
    width: 4,
    dashPattern: "12,8",
    arrowColor: "none",
    arrowSize: 0,
    shadowBlur: 0,
    shadowColor: "rgba(255,255,255,0.8)",
    lineCap: "butt",
  },
}

export interface LabelStyle {
  textColor: string
  backgroundColor: string
  padding: number
  fontSize: number
  hoveredFontSize: number
  fontWeight: number | string
  mutedOpacity: number
}

export interface LabelStyles {
  sectorId: LabelStyle
  portCode: LabelStyle
  shipCount: LabelStyle
}

export const DEFAULT_LABEL_STYLES: LabelStyles = {
  sectorId: {
    textColor: "#000000",
    backgroundColor: "#ffffff",
    padding: 2,
    fontSize: 10,
    hoveredFontSize: 12,
    fontWeight: 800,
    mutedOpacity: 0.3,
  },
  portCode: {
    textColor: "#000000",
    backgroundColor: "#ffffff",
    padding: 2,
    fontSize: 10,
    hoveredFontSize: 12,
    fontWeight: 800,
    mutedOpacity: 0.3,
  },
  shipCount: {
    textColor: "#000000",
    backgroundColor: "#53eafd",
    padding: 2,
    fontSize: 11,
    hoveredFontSize: 13,
    fontWeight: 800,
    mutedOpacity: 0.3,
  },
}

export interface PortStyle {
  color: string
  size: number
  mutedColor: string
}

export interface PortStyles {
  regular: PortStyle
  mega: PortStyle
}

export const DEFAULT_PORT_STYLES: PortStyles = {
  regular: {
    color: "#FFFFFF",
    size: 16,
    mutedColor: "rgba(40,40,40,0.5)",
  },
  mega: {
    color: "#ffd700",
    size: 16,
    mutedColor: "rgba(40,40,40,0.5)",
  },
}

export interface UIStyles {
  grid: {
    color: string
    lineWidth: number
  }
  background: {
    color: string
  }
  edgeFeather: {
    size: number
    falloff?: number
  }
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
    size: 150,
    falloff: 1,
  },
}

export const DEFAULT_SECTORMAP_CONFIG: Omit<SectorMapConfigBase, "center_sector_id"> = {
  camera_viewport_mode: "default",
  highlight_center_sector: true,
  grid_spacing: 28,
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
  show_sector_ids_hover: true,
  show_ports: true,
  show_port_labels: true,
  show_partial_lanes: true,
  partial_lane_max_length: 40,
  clickable: false,
  hoverable: true,
  draggable: false,
  scrollZoom: false,
  hover_scale_factor: 1.15,
  hover_animation_duration: 150,
  current_sector_scale: 1,
  nodeStyles: DEFAULT_NODE_STYLES,
  laneStyles: DEFAULT_LANE_STYLES,
  labelStyles: DEFAULT_LABEL_STYLES,
  portStyles: DEFAULT_PORT_STYLES,
  uiStyles: DEFAULT_UI_STYLES,
  regionStyles: DEFAULT_REGION_STYLES,
  regionLaneStyles: DEFAULT_REGION_LANE_STYLES,
}

export interface SectorMapProps {
  width: number
  height: number
  /** Exact physical pixel dimensions from devicePixelContentBoxSize.
   *  When set, used directly for canvas.width/height (skipping DPR multiply). */
  physicalWidth?: number
  physicalHeight?: number
  data: MapData
  config: SectorMapConfigBase
  maxDistance?: number
  coursePlot?: CoursePlot | null
  ships?: Map<number, Array<{ ship_name: string; ship_type: string }>>
  corp_member_ships?: Map<number, Array<{ character_name: string; ship_name: string }>>
}

export interface CameraState {
  offsetX: number
  offsetY: number
  zoom: number
  filteredData: MapData
  fadingOutData?: MapData
  fadingInData?: MapData
  fadeProgress?: number
}

interface AnimationState {
  isAnimating: boolean
  startTime: number
  panDuration: number
  zoomDuration: number
  fadeDuration: number
  startCamera: CameraState
  targetCamera: CameraState
  animationFrameId?: number
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** Compute grid spacing, hex size, and scale from config and canvas dimensions */
function getGridMetrics(
  config: SectorMapConfigBase,
  width: number,
  height: number
): { gridSpacing: number; hexSize: number; scale: number } {
  const gridSpacing = config.grid_spacing ?? Math.min(width, height) / 10
  const hexSize = config.hex_size ?? gridSpacing * 0.85
  const scale = gridSpacing
  return { gridSpacing, hexSize, scale }
}

/** Slugify region name for style lookup: lowercase, replace spaces with hyphens */
function slugifyRegion(region: string): string {
  return region.toLowerCase().replace(/\s+/g, "-")
}

/** Build an index for O(1) sector lookups by id */
function createSectorIndex(data: MapData): Map<number, MapSectorNode> {
  const index = new Map<number, MapSectorNode>()
  data.forEach((sector) => index.set(sector.id, sector))
  return index
}

function interpolateCameraState(
  start: CameraState,
  target: CameraState,
  panProgress: number,
  zoomProgress: number,
  fadeProgress: number
): CameraState {
  const easedPan = easeInOutCubic(panProgress)
  const easedZoom = easeInOutCubic(zoomProgress)
  return {
    offsetX: start.offsetX + (target.offsetX - start.offsetX) * easedPan,
    offsetY: start.offsetY + (target.offsetY - start.offsetY) * easedPan,
    zoom: start.zoom + (target.zoom - start.zoom) * easedZoom,
    filteredData: start.filteredData,
    fadingOutData: start.fadingOutData,
    fadingInData: start.fadingInData,
    fadeProgress,
  }
}

function hexToWorld(hexX: number, hexY: number, scale: number): { x: number; y: number } {
  const x = scale * 1.5 * hexX
  const y = scale * Math.sqrt(3) * (hexY + 0.5 * (hexX & 1))
  return { x, y }
}

function drawHex(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, fill = false) {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i
    const px = x + size * Math.cos(angle)
    const py = y + size * Math.sin(angle)
    if (i === 0) {
      ctx.moveTo(px, py)
    } else {
      ctx.lineTo(px, py)
    }
  }
  ctx.closePath()
  if (fill) ctx.fill()
  ctx.stroke()
}

function drawSplitHex(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  fillA: string,
  fillB: string,
  borderA: string,
  borderB: string,
  borderWidth: number,
  opacity: number
) {
  const verts = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i
    return { px: x + size * Math.cos(angle), py: y + size * Math.sin(angle) }
  })

  const buildHexPath = () => {
    const p = new Path2D()
    p.moveTo(verts[0].px, verts[0].py)
    for (let i = 1; i < 6; i++) p.lineTo(verts[i].px, verts[i].py)
    p.closePath()
    return p
  }

  // --- Fill ---
  ctx.save()
  ctx.clip(buildHexPath())

  ctx.fillStyle = applyAlpha(fillA, opacity)
  ctx.fillRect(x - size, y - size, size * 2, size * 2)

  ctx.beginPath()
  ctx.moveTo(x + size, y - size)
  ctx.lineTo(x - size, y + size)
  ctx.lineTo(x + size, y + size)
  ctx.closePath()
  ctx.fillStyle = applyAlpha(fillB, opacity)
  ctx.fill()

  ctx.restore()

  // --- Border (split via diagonal clip) ---
  ctx.lineWidth = borderWidth

  // Top-left half border
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x - size, y - size)
  ctx.lineTo(x + size, y - size)
  ctx.lineTo(x - size, y + size)
  ctx.closePath()
  ctx.clip()
  ctx.strokeStyle = applyAlpha(borderA, opacity)
  ctx.stroke(buildHexPath())
  ctx.restore()

  // Bottom-right half border
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x + size, y - size)
  ctx.lineTo(x - size, y + size)
  ctx.lineTo(x + size, y + size)
  ctx.closePath()
  ctx.clip()
  ctx.strokeStyle = applyAlpha(borderB, opacity)
  ctx.stroke(buildHexPath())
  ctx.restore()
}

/** Filter sectors by spatial distance from a center point (in hex grid units).
 *  All coordinate inputs must be in scaled world space (same as hexToWorld output).
 *  When viewportWidth/Height are provided, uses rectangular filtering scaled by
 *  aspect ratio so sectors fill the wider axis without dead space. */
/** Compute aspect-scaled rectangular extents from a world-distance radius. */
const getViewportWorldExtents = (
  maxWorldDistance: number,
  viewportWidth: number,
  viewportHeight: number
) => {
  const safeWidth = Math.max(1, viewportWidth)
  const safeHeight = Math.max(1, viewportHeight)
  const aspect = safeWidth / safeHeight
  return {
    maxDistX: maxWorldDistance * Math.max(1, aspect),
    maxDistY: maxWorldDistance * Math.max(1, 1 / aspect),
  }
}

function filterSectorsBySpatialDistance(
  data: MapData,
  currentSectorId: number,
  maxDistanceHexes: number,
  scale: number,
  centerWorldScaled?: { x: number; y: number },
  viewportWidth?: number,
  viewportHeight?: number,
  useViewportRect?: boolean
): MapData {
  // Resolve center: explicit override or look up current sector
  let center: { x: number; y: number } | null = centerWorldScaled ?? null
  if (!center) {
    const currentSector = data.find((s) => s.id === currentSectorId)
    if (!currentSector) return data
    center = hexToWorld(currentSector.position[0], currentSector.position[1], scale)
  }

  const maxWorldDistance = maxDistanceHexes * scale * Math.sqrt(3)

  // Use rectangular filtering only in viewport_rect mode
  if (
    useViewportRect &&
    viewportWidth &&
    viewportHeight &&
    viewportWidth > 0 &&
    viewportHeight > 0
  ) {
    const { maxDistX, maxDistY } = getViewportWorldExtents(
      maxWorldDistance,
      viewportWidth,
      viewportHeight
    )

    const filtered = data.filter((node) => {
      const world = hexToWorld(node.position[0], node.position[1], scale)
      return Math.abs(world.x - center.x) <= maxDistX && Math.abs(world.y - center.y) <= maxDistY
    })

    if (filtered.length > 0) return filtered
    const fallback = data.find((s) => s.id === currentSectorId)
    return fallback ? [fallback] : data
  }

  // Circular filtering (default mode)
  const filtered = data.filter((node) => {
    const world = hexToWorld(node.position[0], node.position[1], scale)
    const dx = world.x - center.x
    const dy = world.y - center.y
    return Math.sqrt(dx * dx + dy * dy) <= maxWorldDistance
  })

  if (filtered.length > 0) return filtered
  const fallback = data.find((s) => s.id === currentSectorId)
  return fallback ? [fallback] : data
}

/** Calculate bounding box of all sectors */
function calculateSectorBounds(
  data: MapData,
  scale: number,
  hexSize: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  data.forEach((node) => {
    const world = hexToWorld(node.position[0], node.position[1], scale)
    minX = Math.min(minX, world.x - hexSize)
    minY = Math.min(minY, world.y - hexSize)
    maxX = Math.max(maxX, world.x + hexSize)
    maxY = Math.max(maxY, world.y + hexSize)
  })

  return { minX, minY, maxX, maxY }
}

/** Calculate camera transform to optimally frame all sectors in data. */
function calculateCameraTransform(
  data: MapData,
  width: number,
  height: number,
  scale: number,
  hexSize: number,
  framePadding = 0
): { offsetX: number; offsetY: number; zoom: number } {
  const bounds = calculateSectorBounds(data, scale, hexSize)
  const boundsWidth = Math.max(bounds.maxX - bounds.minX, hexSize)
  const boundsHeight = Math.max(bounds.maxY - bounds.minY, hexSize)

  const scaleX = (width - framePadding * 2) / boundsWidth
  const scaleY = (height - framePadding * 2) / boundsHeight
  const zoom = Math.max(0.3, Math.min(scaleX, scaleY, 1.5))

  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2

  return { offsetX: -centerX, offsetY: -centerY, zoom }
}

/** Render debug bounding box visualization */
function renderDebugBounds(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  hexSize: number
) {
  const bounds = calculateSectorBounds(data, scale, hexSize)
  ctx.save()
  ctx.strokeStyle = "#00ff00"
  ctx.lineWidth = 2
  ctx.setLineDash([5, 5])
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  ctx.strokeRect(bounds.minX, bounds.minY, width, height)
  ctx.restore()
}

/** Render directional arrow for one-way lanes (positioned at middle of lane) */
function renderArrow(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  arrowSize: number
) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  // Position arrow at the middle of the lane
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2

  ctx.beginPath()
  ctx.moveTo(midX, midY)
  ctx.lineTo(
    midX - arrowSize * Math.cos(angle - Math.PI / 6),
    midY - arrowSize * Math.sin(angle - Math.PI / 6)
  )
  ctx.moveTo(midX, midY)
  ctx.lineTo(
    midX - arrowSize * Math.cos(angle + Math.PI / 6),
    midY - arrowSize * Math.sin(angle + Math.PI / 6)
  )
  ctx.stroke()
}

/** Calculate point on hex edge in direction of target */
function getHexEdgePoint(
  center: { x: number; y: number },
  target: { x: number; y: number },
  hexSize: number
): { x: number; y: number } {
  const dx = target.x - center.x
  const dy = target.y - center.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance === 0) return center

  const ratio = hexSize / distance
  return {
    x: center.x + dx * ratio,
    y: center.y + dy * ratio,
  }
}

/** Render a single lane between two sectors */
function renderLane(
  ctx: CanvasRenderingContext2D,
  fromNode: MapSectorNode,
  toNode: MapSectorNode,
  scale: number,
  hexSize: number,
  config: SectorMapConfigBase,
  isBidirectional: boolean,
  coursePlotLanes: Set<string> | null = null,
  coursePlot: CoursePlot | null = null
) {
  const fromCenter = hexToWorld(fromNode.position[0], fromNode.position[1], scale)
  const toCenter = hexToWorld(toNode.position[0], toNode.position[1], scale)

  const from = getHexEdgePoint(fromCenter, toCenter, hexSize)
  const to = getHexEdgePoint(toCenter, fromCenter, hexSize)

  // Determine lane type priority
  const isInPlot =
    coursePlotLanes ? coursePlotLanes.has(getUndirectedLaneKey(fromNode.id, toNode.id)) : true

  let laneStyle: LaneStyle
  if (coursePlotLanes && !isInPlot) {
    laneStyle = config.laneStyles.muted
  } else if (coursePlot && isInPlot) {
    laneStyle = config.laneStyles.coursePlot
  } else if (isBidirectional) {
    laneStyle = config.laneStyles.normal
  } else {
    laneStyle = config.laneStyles.oneWay
  }

  // Apply region lane style overrides (only when no course plot is active)
  if (!coursePlot && fromNode.region && config.regionLaneStyles) {
    const regionKey = slugifyRegion(fromNode.region)
    const regionOverride = config.regionLaneStyles[regionKey]
    if (regionOverride) {
      const regionColor = isBidirectional ? regionOverride.twoWayColor : regionOverride.oneWayColor
      const regionArrowColor =
        isBidirectional ? regionOverride.twoWayArrowColor : regionOverride.oneWayArrowColor
      if (regionColor || regionArrowColor) {
        laneStyle = {
          ...laneStyle,
          ...(regionColor && { color: regionColor }),
          ...(regionArrowColor && { arrowColor: regionArrowColor }),
        }
      }
    }
  }

  // Apply lane style
  ctx.strokeStyle = laneStyle.color
  ctx.lineWidth = laneStyle.width
  ctx.lineCap = laneStyle.lineCap
  if (laneStyle.dashPattern !== "none") {
    ctx.setLineDash(laneStyle.dashPattern.split(",").map((n) => parseFloat(n)))
  } else {
    ctx.setLineDash([])
  }

  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()

  // Determine if arrow is needed
  let needsArrow = laneStyle.arrowColor !== "none" && laneStyle.arrowSize > 0
  let arrowFrom = from
  let arrowTo = to

  if (coursePlot && isInPlot) {
    const fromIndex = coursePlot.path.indexOf(fromNode.id)
    const toIndex = coursePlot.path.indexOf(toNode.id)

    if (fromIndex !== -1 && toIndex !== -1 && Math.abs(fromIndex - toIndex) === 1) {
      needsArrow = true
      if (fromIndex < toIndex) {
        arrowFrom = from
        arrowTo = to
      } else {
        arrowFrom = to
        arrowTo = from
      }
    }
  }

  // Only apply length threshold for course plot lanes (short lanes look cluttered with arrows)
  const isCoursePlotLane = coursePlot && isInPlot
  const laneLength = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2)
  const meetsLengthThreshold = !isCoursePlotLane || laneLength >= MIN_LANE_LENGTH_FOR_ARROWS

  if (needsArrow && meetsLengthThreshold) {
    ctx.strokeStyle = laneStyle.arrowColor !== "none" ? laneStyle.arrowColor : laneStyle.color
    renderArrow(ctx, arrowFrom, arrowTo, laneStyle.arrowSize)
  }
}

function getUndirectedLaneKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
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
  const fromCenter = hexToWorld(fromNode.position[0], fromNode.position[1], scale)
  const toCenter = hexToWorld(culledToNode.position[0], culledToNode.position[1], scale)

  const from = getHexEdgePoint(fromCenter, toCenter, hexSize)
  let to = getHexEdgePoint(toCenter, fromCenter, hexSize)

  // Clamp the lane length if max length is configured
  if (config.partial_lane_max_length !== undefined) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const distance = Math.sqrt(dx * dx + dy * dy)

    if (distance > config.partial_lane_max_length) {
      const ratio = config.partial_lane_max_length / distance
      to = {
        x: from.x + dx * ratio,
        y: from.y + dy * ratio,
      }
    }
  }

  // Determine which style to use
  const isInPlot =
    coursePlotLanes ? coursePlotLanes.has(getUndirectedLaneKey(fromNode.id, culledToNode.id)) : true

  let laneStyle =
    coursePlotLanes && !isInPlot ? config.laneStyles.muted
    : coursePlot && isInPlot ? config.laneStyles.coursePlot
    : config.laneStyles.partial

  // Apply region lane style overrides (only when no course plot is active)
  if (!coursePlot && fromNode.region && config.regionLaneStyles) {
    const regionKey = slugifyRegion(fromNode.region)
    const regionOverride = config.regionLaneStyles[regionKey]
    if (regionOverride?.twoWayColor) {
      laneStyle = { ...laneStyle, color: regionOverride.twoWayColor }
    }
  }

  ctx.save()

  // Create gradient that fades out towards the end
  const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y)
  gradient.addColorStop(0, laneStyle.color)
  gradient.addColorStop(0.7, laneStyle.color)
  gradient.addColorStop(1, applyAlpha(laneStyle.color, 0))

  ctx.strokeStyle = gradient
  ctx.lineWidth = laneStyle.width
  ctx.lineCap = laneStyle.lineCap
  if (laneStyle.dashPattern !== "none") {
    ctx.setLineDash(laneStyle.dashPattern.split(",").map((n) => parseFloat(n)))
  }

  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()

  // Add arrow for partial lanes if style specifies (skip if lane is too short)
  const laneLength = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2)
  if (
    laneStyle.arrowColor !== "none" &&
    laneStyle.arrowSize > 0 &&
    laneLength >= MIN_LANE_LENGTH_FOR_ARROWS &&
    coursePlot &&
    isInPlot
  ) {
    const fromIndex = coursePlot.path.indexOf(fromNode.id)
    const toIndex = coursePlot.path.indexOf(culledToNode.id)

    if (fromIndex !== -1 && toIndex !== -1 && Math.abs(fromIndex - toIndex) === 1) {
      const arrowFrom = fromIndex < toIndex ? from : to
      const arrowTo = fromIndex < toIndex ? to : from
      ctx.strokeStyle = laneStyle.arrowColor
      renderArrow(ctx, arrowFrom, arrowTo, laneStyle.arrowSize)
    }
  }

  ctx.restore()
}

/** Render all lanes between sectors */
function renderAllLanes(
  ctx: CanvasRenderingContext2D,
  filteredData: MapData,
  fullData: MapData,
  scale: number,
  hexSize: number,
  config: SectorMapConfigBase,
  coursePlotLanes: Set<string> | null = null,
  coursePlot: CoursePlot | null = null
): void {
  const renderedLanes = new Set<string>()
  const filteredIndex = createSectorIndex(filteredData)
  const fullIndex = createSectorIndex(fullData)

  filteredData.forEach((fromNode) => {
    fromNode.lanes.forEach((lane) => {
      const toNode = filteredIndex.get(lane.to)

      if (!toNode) {
        // Check if fromNode is visited and we should render partial lanes
        if (config.show_partial_lanes && fromNode.visited) {
          const culledToNode = fullIndex.get(lane.to)
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
            )
          }
        }
        return
      }

      const isBidirectional = lane.two_way

      if (isBidirectional) {
        const laneKey = getUndirectedLaneKey(fromNode.id, lane.to)
        if (renderedLanes.has(laneKey)) return
        renderedLanes.add(laneKey)
      } else {
        // For one-way lanes, only render from visited sectors
        // (we only know about one-way lanes we've actually discovered)
        if (!fromNode.visited) return
      }

      renderLane(
        ctx,
        fromNode,
        toNode,
        scale,
        hexSize,
        config,
        isBidirectional,
        coursePlotLanes,
        coursePlot
      )
    })
  })
}

/** Apply opacity to color (multiplies existing alpha if present) */
function applyAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  if (color.startsWith("rgba")) {
    const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/)
    if (match) {
      const existingAlpha = parseFloat(match[4])
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${existingAlpha * alpha})`
    }
    return color.replace(/[\d.]+\)$/, `${alpha})`)
  }
  if (color.startsWith("rgb")) {
    const match = color.match(/rgb\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/)
    if (match) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`
    }
  }
  return color
}

/** Use the app's computed font-family (canvas or body) for labels */
let cachedFontFamily: string | null = null
function getCanvasFontFamily(ctx: CanvasRenderingContext2D): string {
  if (cachedFontFamily) return cachedFontFamily
  try {
    const canvasEl = ctx.canvas as HTMLCanvasElement | undefined
    const canvasFamily = canvasEl ? window.getComputedStyle(canvasEl).fontFamily : ""
    const bodyFamily = window.getComputedStyle(document.body).fontFamily
    cachedFontFamily = canvasFamily || bodyFamily || "sans-serif"
  } catch {
    cachedFontFamily = "sans-serif"
  }
  return cachedFontFamily
}

/** Get the computed node style for a sector (used for glow rendering) */
function getNodeStyle(
  node: MapSectorNode,
  config: SectorMapConfigBase,
  hoveredSectorId: number | null = null
): NodeStyle {
  const isCurrent = config.current_sector_id !== undefined && node.id === config.current_sector_id
  const isVisited = Boolean(node.visited) || isCurrent
  const isHovered = node.id === hoveredSectorId
  const isCentered =
    config.highlight_center_sector !== false && node.id === config.center_sector_id && !isCurrent
  const isMegaPort = Boolean((node.port as Port | null)?.mega)
  const hasGarrison = Boolean(node.garrison)

  let baseStyle: NodeStyle

  if (isCurrent) {
    // Current sector always gets the current style (blue) regardless of port/garrison
    baseStyle = config.nodeStyles.current
  } else if (hasGarrison) {
    baseStyle = config.nodeStyles.garrison
  } else if (isMegaPort) {
    baseStyle = config.nodeStyles.megaPort
  } else if (isVisited) {
    if (node.source === "corp") {
      baseStyle = config.nodeStyles.visited_corp
    } else {
      baseStyle = config.nodeStyles.visited
    }
  } else {
    baseStyle = config.nodeStyles.unvisited
  }

  // Apply region overrides (skip for current and garrison nodes — those styles take full priority)
  if (!isCurrent && !hasGarrison && node.region && config.regionStyles) {
    let regionKey = slugifyRegion(node.region)
    if (isVisited && isBorderSector(node)) {
      const borderKey = `${regionKey}-border`
      if (config.regionStyles[borderKey]) {
        regionKey = borderKey
      }
    }
    const regionOverride = config.regionStyles[regionKey]
    if (regionOverride) {
      if (isVisited) {
        baseStyle = { ...baseStyle, ...regionOverride }
      } else {
        // Unvisited: region fill, keep original gray border on the edge,
        // add an inset frame in the faded region color for visual distinction
        baseStyle = {
          ...baseStyle,
          fill: regionOverride.fill ? applyAlpha(regionOverride.fill, 0.3) : baseStyle.fill,
          outline: "none",
          outlineWidth: 0,
          insetBorder: regionOverride.border ? applyAlpha(regionOverride.border, 0.5) : undefined,
          insetBorderWidth: 2,
          insetBorderOffset: 6,
        }
      }
    }
  }

  let nodeStyle: NodeStyle = baseStyle
  if (isCentered) {
    nodeStyle = { ...baseStyle, ...config.nodeStyles.centered }
  }
  // Don't apply hover overrides to the centered/selected node
  if (isHovered && (config.clickable || config.hoverable) && !isCentered) {
    nodeStyle = { ...baseStyle, ...config.nodeStyles.hovered }
  }

  return nodeStyle
}

/** Render only the glow effects for all sectors (separate pass for feathering) */
function renderSectorGlows(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  config: SectorMapConfigBase,
  opacity = 1,
  coursePlotSectors: Set<number> | null = null,
  hoveredSectorId: number | null = null
) {
  data.forEach((node) => {
    const nodeStyle = getNodeStyle(node, config, hoveredSectorId)

    if (nodeStyle.glow && nodeStyle.glowRadius && nodeStyle.glowColor) {
      const world = hexToWorld(node.position[0], node.position[1], scale)
      // Reduce glow opacity for nodes not in the active course plot
      const nodeOpacity =
        coursePlotSectors && !coursePlotSectors.has(node.id) ?
          opacity * COURSE_PLOT_INACTIVE_NODE_OPACITY
        : opacity
      ctx.save()
      const falloff = nodeStyle.glowFalloff ?? 0.3
      const gradient = ctx.createRadialGradient(
        world.x,
        world.y,
        0,
        world.x,
        world.y,
        nodeStyle.glowRadius
      )
      gradient.addColorStop(0, applyAlpha(nodeStyle.glowColor, nodeOpacity))
      gradient.addColorStop(falloff, applyAlpha(nodeStyle.glowColor, nodeOpacity))
      gradient.addColorStop(1, applyAlpha(nodeStyle.glowColor, 0))
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(world.x, world.y, nodeStyle.glowRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  })
}

/** Render a sector hex with optional opacity for fade effects */
function renderSector(
  ctx: CanvasRenderingContext2D,
  node: MapSectorNode,
  scale: number,
  hexSize: number,
  config: SectorMapConfigBase,
  opacity = 1,
  coursePlotSectors: Set<number> | null = null,
  hoveredSectorId: number | null = null,
  animatingSectorId: number | null = null,
  hoverScale = 1
) {
  const world = hexToWorld(node.position[0], node.position[1], scale)
  const isCurrent = config.current_sector_id !== undefined && node.id === config.current_sector_id
  const isAnimating = node.id === animatingSectorId

  const isInPlot = coursePlotSectors ? coursePlotSectors.has(node.id) : true
  // Reduce opacity for nodes not in the active course plot
  const finalOpacity =
    coursePlotSectors && !isInPlot ? opacity * COURSE_PLOT_INACTIVE_NODE_OPACITY : opacity

  // Apply scale: current sector gets permanent scale, hover scale stacks on top
  const currentScale = isCurrent && config.current_sector_scale ? config.current_sector_scale : 1
  const effectiveHexSize =
    isAnimating ? hexSize * currentScale * hoverScale : hexSize * currentScale

  // Get computed node style
  const nodeStyle = getNodeStyle(node, config, hoveredSectorId)

  // NOTE: Glow is rendered separately in renderSectorGlows() so it can be feathered

  // NOTE: Offset frame is rendered in a separate pass (renderSectorOffsetFrames)
  // so it always appears on top of all other sectors.

  // Render outline if specified
  if (nodeStyle.outline !== "none" && nodeStyle.outlineWidth > 0) {
    ctx.save()
    ctx.strokeStyle = applyAlpha(nodeStyle.outline, finalOpacity)
    ctx.lineWidth = nodeStyle.outlineWidth
    drawHex(ctx, world.x, world.y, effectiveHexSize + nodeStyle.outlineWidth / 2 + 2, false)
    ctx.restore()
  }

  // Render fill and border
  ctx.strokeStyle = applyAlpha(nodeStyle.border, finalOpacity)
  ctx.lineWidth = nodeStyle.borderWidth

  // Apply border style (solid, dashed, dotted)
  if (nodeStyle.borderStyle === "dotted") {
    ctx.setLineDash([2, 2])
    ctx.lineCap = "butt"
  } else if (nodeStyle.borderStyle === "dashed") {
    ctx.setLineDash([6, 4])
    ctx.lineCap = "butt"
  } else {
    ctx.setLineDash([])
  }

  if (nodeStyle.splitFill) {
    // Diagonal split fill and border: top-left = A colors, bottom-right = B colors
    drawSplitHex(
      ctx,
      world.x,
      world.y,
      effectiveHexSize,
      nodeStyle.fill,
      nodeStyle.splitFill,
      nodeStyle.border,
      nodeStyle.splitBorder ?? nodeStyle.border,
      nodeStyle.borderWidth,
      finalOpacity
    )
  } else if (nodeStyle.borderPosition === "inside") {
    // Handle border position: "inside" draws border inset from edge
    ctx.fillStyle = applyAlpha(nodeStyle.fill, finalOpacity)
    // Draw fill at full size without border
    ctx.save()
    ctx.strokeStyle = "transparent"
    drawHex(ctx, world.x, world.y, effectiveHexSize, true)
    ctx.restore()
    // Draw border inset from edge
    const inset = nodeStyle.borderInset ?? nodeStyle.borderWidth / 2
    drawHex(ctx, world.x, world.y, effectiveHexSize - inset, false)
  } else {
    // Default: border centered on edge
    ctx.fillStyle = applyAlpha(nodeStyle.fill, finalOpacity)
    drawHex(ctx, world.x, world.y, effectiveHexSize, true)
  }
  ctx.setLineDash([])
  ctx.lineCap = "butt"

  // Render inset border if specified (second border drawn inside the hex)
  if (nodeStyle.insetBorder && nodeStyle.insetBorderWidth && nodeStyle.insetBorderOffset) {
    ctx.save()
    ctx.strokeStyle = applyAlpha(nodeStyle.insetBorder, finalOpacity)
    ctx.lineWidth = nodeStyle.insetBorderWidth
    drawHex(ctx, world.x, world.y, effectiveHexSize - nodeStyle.insetBorderOffset, false)
    ctx.restore()
  }

  // Render icon: garrison takes priority over port icons
  if (node.garrison) {
    const iconColor = nodeStyle.iconColor ?? "#fecaca"
    const portStyle = config.portStyles.regular
    const effectiveSize = isAnimating ? portStyle.size * hoverScale : portStyle.size

    ctx.save()
    ctx.translate(world.x, world.y)
    const iconScale = effectiveSize / GARRISON_ICON_VIEWBOX
    ctx.scale(iconScale, iconScale)
    ctx.translate(-GARRISON_ICON_VIEWBOX / 2, -GARRISON_ICON_VIEWBOX / 2)
    ctx.fillStyle = applyAlpha(iconColor, finalOpacity)
    ctx.fill(garrisonPath)
    ctx.restore()
  } else if (node.port) {
    const isMegaPort = Boolean((node.port as Port | null)?.mega)
    const portStyle = isMegaPort ? config.portStyles.mega : config.portStyles.regular

    // Use nodeStyle.iconColor if set, otherwise fall back to portStyle colors
    let portColor: string
    if (nodeStyle.iconColor) {
      portColor = nodeStyle.iconColor
    } else {
      portColor = portStyle.color
    }

    // Scale port size with hover animation
    const effectiveSize = isAnimating ? portStyle.size * hoverScale : portStyle.size

    ctx.save()
    ctx.translate(world.x, world.y)

    // Scale from 256x256 viewBox to desired size
    const scale = effectiveSize / PORT_ICON_VIEWBOX
    ctx.scale(scale, scale)

    // Center the icon
    ctx.translate(-PORT_ICON_VIEWBOX / 2, -PORT_ICON_VIEWBOX / 2)

    ctx.fillStyle = applyAlpha(portColor, finalOpacity)
    ctx.fill(isMegaPort ? megaPortPath : portPath)
    ctx.restore()
  }
}

/** Render offset frames for sectors that have them (separate pass so they draw on top of all sectors) */
function renderSectorOffsetFrames(
  ctx: CanvasRenderingContext2D,
  data: MapSectorNode[],
  scale: number,
  hexSize: number,
  config: SectorMapConfigBase,
  coursePlotSectors: Set<number> | null = null,
  hoveredSectorId: number | null = null,
  animatingSectorId: number | null = null,
  hoverScale = 1
) {
  data.forEach((node) => {
    const isCurrent = config.current_sector_id !== undefined && node.id === config.current_sector_id
    const isAnimating = node.id === animatingSectorId
    const isInPlot = coursePlotSectors ? coursePlotSectors.has(node.id) : true
    const finalOpacity = coursePlotSectors && !isInPlot ? COURSE_PLOT_INACTIVE_NODE_OPACITY : 1

    const nodeStyle = getNodeStyle(node, config, hoveredSectorId)
    if (
      !nodeStyle.offset ||
      !nodeStyle.offsetColor ||
      !nodeStyle.offsetSize ||
      !nodeStyle.offsetWeight
    ) {
      return
    }

    const world = hexToWorld(node.position[0], node.position[1], scale)
    const currentScale = isCurrent && config.current_sector_scale ? config.current_sector_scale : 1
    const effectiveHexSize =
      isAnimating ? hexSize * currentScale * hoverScale : hexSize * currentScale

    ctx.save()
    ctx.strokeStyle = applyAlpha(nodeStyle.offsetColor, finalOpacity)
    ctx.lineWidth = nodeStyle.offsetWeight
    drawHex(ctx, world.x, world.y, effectiveHexSize + nodeStyle.offsetSize, false)
    ctx.restore()
  })
}

/** Render hop number badges for course plot sectors (rendered above animation overlay) */
function renderCoursePlotBadges(
  ctx: CanvasRenderingContext2D,
  scale: number,
  hexSize: number,
  width: number,
  height: number,
  cameraState: CameraState,
  coursePlot: CoursePlot
) {
  const coursePlotSectors = new Set(coursePlot.path)

  ctx.save()
  ctx.translate(width / 2, height / 2)
  ctx.scale(cameraState.zoom, cameraState.zoom)
  ctx.translate(cameraState.offsetX, cameraState.offsetY)

  cameraState.filteredData.forEach((node) => {
    if (!coursePlotSectors.has(node.id)) return
    const hopIndex = coursePlot.path.indexOf(node.id)
    if (hopIndex === -1) return

    const hopNumber = hopIndex + 1
    const world = hexToWorld(node.position[0], node.position[1], scale)

    ctx.save()

    const fontSize = hexSize * 0.55
    ctx.font = `bold ${fontSize}px ${getCanvasFontFamily(ctx)}`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"

    // Offset to top-left of hex
    const badgeOffsetX = hexSize * -0.7
    const badgeOffsetY = hexSize * -0.55
    const badgeX = world.x + badgeOffsetX
    const badgeY = world.y + badgeOffsetY

    // Draw square background
    const text = hopNumber.toString()
    const metrics = ctx.measureText(text)
    const badgePad = fontSize * 0.4
    const badgeSize = Math.max(metrics.width, fontSize) + badgePad * 2
    const badgeR = fontSize * 0.15

    ctx.fillStyle = applyAlpha("#000000", 0.85)
    ctx.beginPath()
    ctx.roundRect(badgeX - badgeSize / 2, badgeY - badgeSize / 2, badgeSize, badgeSize, badgeR)
    ctx.fill()

    // Draw white text
    ctx.fillStyle = applyAlpha("#ffffff", 0.95)
    ctx.fillText(text, badgeX, badgeY)
    ctx.restore()
  })

  ctx.restore()
}

/** Cached hex grid renderer. The grid only depends on camera + viewport params,
 *  not on interaction state (hover, course plot animation), so we cache it to
 *  an OffscreenCanvas and reuse across hover/animation frames. */
let hexGridCache: { canvas: OffscreenCanvas; key: string } | null = null

function renderHexGridCached(
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
  const dpr = window.devicePixelRatio || 1
  const key = `${width},${height},${dpr},${cameraZoom},${cameraOffsetX},${cameraOffsetY},${scale},${hexSize},${gridStyle.color},${gridStyle.lineWidth}`

  if (!hexGridCache || hexGridCache.key !== key) {
    const pw = Math.ceil(width * dpr)
    const ph = Math.ceil(height * dpr)
    const osc = new OffscreenCanvas(pw, ph)
    const oscCtx = osc.getContext("2d")
    if (!oscCtx) {
      // Fallback: render directly
      renderHexGrid(
        ctx,
        width,
        height,
        cameraZoom,
        cameraOffsetX,
        cameraOffsetY,
        scale,
        hexSize,
        gridStyle
      )
      return
    }

    // Bake DPR + camera transforms into the cached image
    oscCtx.scale(dpr, dpr)
    oscCtx.translate(width / 2, height / 2)
    oscCtx.scale(cameraZoom, cameraZoom)
    oscCtx.translate(cameraOffsetX, cameraOffsetY)
    renderHexGrid(
      oscCtx as unknown as CanvasRenderingContext2D,
      width,
      height,
      cameraZoom,
      cameraOffsetX,
      cameraOffsetY,
      scale,
      hexSize,
      gridStyle
    )

    hexGridCache = { canvas: osc, key }
  }

  // Draw cached grid at identity (transforms are baked into the cached image)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(hexGridCache.canvas, 0, 0)
  ctx.restore()
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
  const stepX = scale * 1.5
  const invScale = 1 / scale
  const sqrt3 = Math.sqrt(3)

  const worldLeft = -width / 2 / cameraZoom - cameraOffsetX
  const worldRight = width / 2 / cameraZoom - cameraOffsetX
  const worldTop = -height / 2 / cameraZoom - cameraOffsetY
  const worldBottom = height / 2 / cameraZoom - cameraOffsetY

  const minHexX = Math.floor(worldLeft / stepX) - 2
  let maxHexX = Math.ceil(worldRight / stepX) + 2

  if (maxHexX - minHexX > 500) {
    maxHexX = minHexX + 500
  }

  ctx.save()
  ctx.strokeStyle = gridStyle.color
  ctx.lineWidth = gridStyle.lineWidth

  for (let hx = minHexX; hx <= maxHexX; hx++) {
    const yOffset = 0.5 * (hx & 1)
    const minHexY = Math.floor((worldTop * invScale) / sqrt3 - yOffset) - 2
    const maxHexY = Math.ceil((worldBottom * invScale) / sqrt3 - yOffset) + 2

    for (let hy = minHexY; hy <= maxHexY; hy++) {
      const world = hexToWorld(hx, hy, scale)
      drawHex(ctx, world.x, world.y, hexSize)
    }
  }

  ctx.restore()
}

/** Build gradient color stops with a power-curve falloff.
 *  falloff=1 is linear, >1 is steeper (sharper edge), <1 is gentler. */
function buildFeatherGradient(gradient: CanvasGradient, inward: boolean, falloff: number) {
  const STEPS = 10
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS
    // alpha goes from 1 (edge) to 0 (interior)
    const alpha = Math.pow(inward ? 1 - t : t, falloff)
    gradient.addColorStop(t, `rgba(0,0,0,${alpha})`)
  }
  return gradient
}

/** Apply a rectangular feather mask around the edges in screen space.
 *  falloff controls the gradient curve: 1=linear, >1=steeper, <1=gentler.
 *  Uses a cached OffscreenCanvas to avoid recreating gradients every frame. */
let featherCache: {
  canvas: OffscreenCanvas
  width: number
  height: number
  dpr: number
  featherSize: number
  falloff: number
} | null = null

function applyRectangularFeatherMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  featherSize: number,
  falloff: number = 1
) {
  if (featherSize <= 0) return

  const dpr = window.devicePixelRatio || 1

  // Check cache validity
  if (
    !featherCache ||
    featherCache.width !== width ||
    featherCache.height !== height ||
    featherCache.dpr !== dpr ||
    featherCache.featherSize !== featherSize ||
    featherCache.falloff !== falloff
  ) {
    // Regenerate cached mask at device pixel resolution
    const pw = Math.ceil(width * dpr)
    const ph = Math.ceil(height * dpr)
    const osc = new OffscreenCanvas(pw, ph)
    const oscCtx = osc.getContext("2d")
    if (!oscCtx) return

    oscCtx.scale(dpr, dpr)

    // Top edge
    let gradient = oscCtx.createLinearGradient(0, 0, 0, featherSize)
    buildFeatherGradient(gradient, true, falloff)
    oscCtx.fillStyle = gradient
    oscCtx.fillRect(0, 0, width, featherSize)

    // Bottom edge
    gradient = oscCtx.createLinearGradient(0, height - featherSize, 0, height)
    buildFeatherGradient(gradient, false, falloff)
    oscCtx.fillStyle = gradient
    oscCtx.fillRect(0, height - featherSize, width, featherSize)

    // Left edge
    gradient = oscCtx.createLinearGradient(0, 0, featherSize, 0)
    buildFeatherGradient(gradient, true, falloff)
    oscCtx.fillStyle = gradient
    oscCtx.fillRect(0, 0, featherSize, height)

    // Right edge
    gradient = oscCtx.createLinearGradient(width - featherSize, 0, width, 0)
    buildFeatherGradient(gradient, false, falloff)
    oscCtx.fillStyle = gradient
    oscCtx.fillRect(width - featherSize, 0, featherSize, height)

    featherCache = { canvas: osc, width, height, dpr, featherSize, falloff }
  }

  // Apply cached mask via compositing — draw at identity since DPR is baked in
  ctx.save()
  ctx.globalCompositeOperation = "destination-out"
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(featherCache.canvas, 0, 0)
  ctx.restore()
}

/** Calculate complete camera state for given props.
 *
 *  Camera center priority:  fit_bounds_world center > center_world > center_sector_id hex position
 *  Camera zoom priority:    fit_bounds_world extent > maxDistance radius > auto-fit (calculateCameraTransform)
 */
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
  const useViewportRect = config.camera_viewport_mode === "viewport_rect"

  // Resolve scaled center for spatial filtering
  const centerWorldScaled =
    config.center_world ?
      { x: config.center_world[0] * scale, y: config.center_world[1] * scale }
    : undefined

  // Filter by spatial distance, using center override and viewport when available
  let filteredData = filterSectorsBySpatialDistance(
    data,
    config.center_sector_id,
    maxDistance,
    scale,
    centerWorldScaled,
    width,
    height,
    useViewportRect
  )

  // If course plot exists, include all sectors from the path
  let framingData = filteredData
  if (coursePlot) {
    const coursePlotSectorIds = new Set(coursePlot.path)
    const sectorIndex = createSectorIndex(data)
    const coursePlotSectors: MapData = []
    const additionalSectors: MapData = []

    coursePlotSectorIds.forEach((sectorId) => {
      const sector = sectorIndex.get(sectorId)
      if (sector) {
        coursePlotSectors.push(sector)
        if (!filteredData.some((s) => s.id === sectorId)) {
          additionalSectors.push(sector)
        }
      }
    })

    if (additionalSectors.length > 0) {
      filteredData = [...filteredData, ...additionalSectors]
    }

    if (coursePlotSectors.length > 0) {
      framingData = coursePlotSectors
    }
  }

  if (filteredData.length === 0) {
    return null
  }

  // Dynamic min zoom floor -- scales down for larger maxDistance values
  const minZoom = Math.max(
    0.08,
    0.3 * (DEFAULT_MAX_BOUNDS / Math.max(maxDistance, DEFAULT_MAX_BOUNDS))
  )

  const framePadding = config.frame_padding ?? 0
  const availableWidth = Math.max(width - framePadding * 2, 1)
  const availableHeight = Math.max(height - framePadding * 2, 1)

  // --- Override path: fit_bounds_world ---
  if (config.fit_bounds_world && config.fit_bounds_world.length === 4) {
    const [bMinX, bMaxX, bMinY, bMaxY] = config.fit_bounds_world
    const paddedMinX = bMinX * scale - hexSize
    const paddedMaxX = bMaxX * scale + hexSize
    const paddedMinY = bMinY * scale - hexSize
    const paddedMaxY = bMaxY * scale + hexSize
    const boundsWidth = Math.max(paddedMaxX - paddedMinX, hexSize * 2)
    const boundsHeight = Math.max(paddedMaxY - paddedMinY, hexSize * 2)

    const centerX = (paddedMinX + paddedMaxX) / 2
    const centerY = (paddedMinY + paddedMaxY) / 2
    const zoom = Math.max(
      minZoom,
      Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight, 1.5)
    )

    return {
      offsetX: -centerX,
      offsetY: -centerY,
      zoom,
      filteredData,
    }
  }

  // --- Viewport-rect mode: center on resolved map center, size by rectangular extents ---
  // Skip when a course plot is active so we fall through to auto-fit framing.
  if (useViewportRect && !coursePlot) {
    const centerSector = data.find((sector) => sector.id === config.center_sector_id)
    const centerSectorScaled =
      centerSector ? hexToWorld(centerSector.position[0], centerSector.position[1], scale) : null
    const resolvedCenterScaled = centerWorldScaled ?? centerSectorScaled
    if (resolvedCenterScaled) {
      const maxWorldDistance = maxDistance * scale * Math.sqrt(3)
      const { maxDistX, maxDistY } = getViewportWorldExtents(maxWorldDistance, width, height)
      const viewportWidthWorld = Math.max((maxDistX + hexSize) * 2, hexSize * 2)
      const viewportHeightWorld = Math.max((maxDistY + hexSize) * 2, hexSize * 2)
      const zoom = Math.max(
        minZoom,
        Math.min(availableWidth / viewportWidthWorld, availableHeight / viewportHeightWorld, 1.5)
      )
      return {
        offsetX: -resolvedCenterScaled.x,
        offsetY: -resolvedCenterScaled.y,
        zoom,
        filteredData,
      }
    }
  }

  // --- Override path: center_world (no fit bounds) ---
  // Skip when a course plot is active so we fall through to auto-fit framing.
  if (centerWorldScaled && !coursePlot) {
    const maxWorldDistance = maxDistance * scale * Math.sqrt(3)
    const radius = Math.max(maxWorldDistance + hexSize, hexSize)
    const zoom = Math.max(
      minZoom,
      Math.min(availableWidth / (radius * 2), availableHeight / (radius * 2), 1.5)
    )

    return {
      offsetX: -centerWorldScaled.x,
      offsetY: -centerWorldScaled.y,
      zoom,
      filteredData,
    }
  }

  // --- Default path: auto-fit to framing data (boundMode) ---
  const camera = calculateCameraTransform(framingData, width, height, scale, hexSize, framePadding)

  // Apply dynamic minZoom floor (calculateCameraTransform uses hardcoded 0.3)
  const zoom = Math.max(minZoom, camera.zoom)

  return {
    offsetX: camera.offsetX,
    offsetY: camera.offsetY,
    zoom,
    filteredData,
  }
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
  }
}

/** Convert screen coordinates to world coordinates */
function screenToWorld(
  screenX: number,
  screenY: number,
  width: number,
  height: number,
  cameraState: CameraState
): { x: number; y: number } {
  return {
    x: (screenX - width / 2) / cameraState.zoom - cameraState.offsetX,
    y: (screenY - height / 2) / cameraState.zoom - cameraState.offsetY,
  }
}

/** Check if a point is inside a hex */
function isPointInHex(
  px: number,
  py: number,
  hexCenterX: number,
  hexCenterY: number,
  hexSize: number
): boolean {
  const dx = Math.abs(px - hexCenterX)
  const dy = Math.abs(py - hexCenterY)
  const sqrt3 = Math.sqrt(3)

  // Quick bounding box check
  if (dx > hexSize || dy > (hexSize * sqrt3) / 2) return false

  // Detailed hex boundary check
  return (hexSize * sqrt3) / 2 - dy >= dx / 2
}

/** Find sector at a world coordinate point */
function findSectorAtPoint(
  worldX: number,
  worldY: number,
  data: MapData,
  scale: number,
  hexSize: number
): MapSectorNode | null {
  for (const sector of data) {
    const world = hexToWorld(sector.position[0], sector.position[1], scale)
    if (isPointInHex(worldX, worldY, world.x, world.y, hexSize)) {
      return sector
    }
  }
  return null
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
  hoveredSectorId: number | null = null
) {
  // Return early if neither show_sector_ids nor show_sector_ids_hover is enabled
  if (!config.show_sector_ids && !config.show_sector_ids_hover) return

  const labelStyle = config.labelStyles.sectorId

  ctx.save()
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"

  const labelOffset = config.sector_label_offset ?? 2
  const padding = labelStyle.padding

  ctx.font = `${labelStyle.fontWeight} ${labelStyle.fontSize}px ${getCanvasFontFamily(ctx)}`

  data.forEach((node) => {
    // Skip labels for current sector (player's location)
    if (config.current_sector_id !== undefined && node.id === config.current_sector_id) return

    const isHovered = node.id === hoveredSectorId
    const isCentered =
      config.highlight_center_sector !== false && node.id === config.center_sector_id

    // If show_sector_ids is false but show_sector_ids_hover is true,
    // only show labels for hovered or centered sectors
    if (!config.show_sector_ids && config.show_sector_ids_hover) {
      if (!isCentered && !isHovered) return
    }

    const hoverScale = isHovered ? labelStyle.hoveredFontSize / labelStyle.fontSize : 1

    const worldPos = hexToWorld(node.position[0], node.position[1], scale)
    const angle = -Math.PI / 3
    const edgeWorldX = worldPos.x + hexSize * Math.cos(angle)
    const edgeWorldY = worldPos.y + hexSize * Math.sin(angle)

    const screenPos = worldToScreen(edgeWorldX, edgeWorldY, width, height, cameraState)

    const text = node.id.toString()
    const textX = screenPos.x + labelOffset
    const textY = screenPos.y

    const metrics = ctx.measureText(text)
    const textWidth = metrics.width
    const ascent =
      metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? labelStyle.fontSize
    const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 0
    const textHeight = ascent + descent

    // Labels are hidden during course plot (early return above), so always full opacity here
    const labelOpacity = 1

    ctx.save()
    ctx.translate(textX, textY)
    ctx.scale(hoverScale, hoverScale)

    ctx.fillStyle = applyAlpha(labelStyle.backgroundColor, labelOpacity)
    ctx.fillRect(-padding, -ascent - padding, textWidth + padding * 2, textHeight + padding * 2)

    ctx.fillStyle = applyAlpha(labelStyle.textColor, labelOpacity)
    ctx.fillText(text, 0, 0)
    ctx.restore()
  })

  ctx.restore()
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
  hoveredSectorId: number | null = null
) {
  if (!config.show_port_labels) return

  const labelStyle = config.labelStyles.portCode

  ctx.save()
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"

  const labelOffset = config.sector_label_offset ?? 2
  const padding = labelStyle.padding

  ctx.font = `${labelStyle.fontWeight} ${labelStyle.fontSize}px ${getCanvasFontFamily(ctx)}`

  data.forEach((node) => {
    const portCode = getPortCode(node.port ?? null)
    if (!portCode) return
    // Skip labels for current sector (player's location)
    if (config.current_sector_id !== undefined && node.id === config.current_sector_id) return

    // Only show port label if:
    // 1. This is the centered (selected) sector, OR
    // 2. This sector is currently hovered
    const isCentered =
      config.highlight_center_sector !== false && node.id === config.center_sector_id
    const isHovered = node.id === hoveredSectorId
    if (!isCentered && !isHovered) return

    const hoverScale = isHovered ? labelStyle.hoveredFontSize / labelStyle.fontSize : 1

    const worldPos = hexToWorld(node.position[0], node.position[1], scale)
    const angle = Math.PI / 3
    const edgeWorldX = worldPos.x + hexSize * Math.cos(angle)
    const edgeWorldY = worldPos.y + hexSize * Math.sin(angle)

    const screenPos = worldToScreen(edgeWorldX, edgeWorldY, width, height, cameraState)

    const text = portCode
    const textX = screenPos.x + labelOffset
    const textY = screenPos.y

    const metrics = ctx.measureText(text)
    const textWidth = metrics.width
    const ascent =
      metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? labelStyle.fontSize
    const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 0
    const textHeight = ascent + descent

    // Labels are hidden during course plot (early return above), so always full opacity here
    const labelOpacity = 1

    ctx.save()
    ctx.translate(textX, textY)
    ctx.scale(hoverScale, hoverScale)

    ctx.fillStyle = applyAlpha(labelStyle.backgroundColor, labelOpacity)
    ctx.fillRect(-padding, -ascent - padding, textWidth + padding * 2, textHeight + padding * 2)

    ctx.fillStyle = applyAlpha(labelStyle.textColor, labelOpacity)
    ctx.fillText(text, 0, 0)
    ctx.restore()
  })

  ctx.restore()
}

/** Truncate text to fit within maxWidth, adding ellipsis if needed */
function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  const ellipsis = "\u2026"
  const ellipsisWidth = ctx.measureText(ellipsis).width
  const targetWidth = maxWidth - ellipsisWidth
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(text.slice(0, mid)).width <= targetWidth) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return text.slice(0, lo) + ellipsis
}

type ShipInfo = { ship_name: string; ship_type: string }

type CorpMemberShipInfo = { character_name: string; ship_name: string }

type ShipLabelHitBox = { sectorId: number; x: number; y: number; w: number; h: number }

/** Render purple glow rings under sectors where other corporation members are located. */
function renderCorpMemberGlows(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  config: SectorMapConfigBase,
  corpMemberShips: Map<number, CorpMemberShipInfo[]> | undefined
) {
  if (!corpMemberShips || corpMemberShips.size === 0) return
  const style = config.nodeStyles.corpMember
  if (!style.glow || !style.glowRadius || !style.glowColor) return
  const currentSectorId = config.current_sector_id
  const falloff = style.glowFalloff ?? 0.3

  data.forEach((node) => {
    if (!corpMemberShips.has(node.id)) return
    if (currentSectorId !== undefined && node.id === currentSectorId) return
    const world = hexToWorld(node.position[0], node.position[1], scale)
    const gradient = ctx.createRadialGradient(
      world.x,
      world.y,
      0,
      world.x,
      world.y,
      style.glowRadius!
    )
    gradient.addColorStop(0, style.glowColor!)
    gradient.addColorStop(falloff, style.glowColor!)
    gradient.addColorStop(1, applyAlpha(style.glowColor!, 0))
    ctx.save()
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(world.x, world.y, style.glowRadius!, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  })
}

/** Render pilot-name labels below sectors that hold corporation-member ships. */
function renderCorpMemberLabels(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  hexSize: number,
  width: number,
  height: number,
  cameraState: CameraState,
  config: SectorMapConfigBase,
  corpMemberShips: Map<number, CorpMemberShipInfo[]> | undefined
) {
  if (!corpMemberShips || corpMemberShips.size === 0) return

  const currentSectorId = config.current_sector_id
  const fontSize = 10
  const padding = 3
  const rowGap = 2
  const labelOffset = config.sector_label_offset ?? 2
  const bgColor = "rgba(88,28,135,0.92)"
  const borderColor = "rgba(216,180,254,1)"
  const textColor = "#f5f3ff"

  ctx.save()
  ctx.font = `800 ${fontSize}px ${getCanvasFontFamily(ctx)}`
  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"

  data.forEach((node) => {
    const members = corpMemberShips.get(node.id)
    if (!members || members.length === 0) return
    if (currentSectorId !== undefined && node.id === currentSectorId) return

    // Anchor at bottom of hex (angle = PI/2 points down in screen space after worldToScreen)
    const worldPos = hexToWorld(node.position[0], node.position[1], scale)
    const edgeWorldX = worldPos.x
    const edgeWorldY = worldPos.y + hexSize
    const screenPos = worldToScreen(edgeWorldX, edgeWorldY, width, height, cameraState)

    const ascent = fontSize * 0.8
    const descent = fontSize * 0.2
    const rowHeight = ascent + descent + padding * 2

    let cursorY = screenPos.y + labelOffset + ascent + padding

    for (const member of members) {
      const label = member.character_name.toUpperCase()
      const textWidth = ctx.measureText(label).width
      const boxX = screenPos.x - textWidth / 2 - padding
      const boxY = cursorY - ascent - padding
      const boxW = textWidth + padding * 2
      const boxH = ascent + descent + padding * 2

      ctx.fillStyle = bgColor
      ctx.fillRect(boxX, boxY, boxW, boxH)
      ctx.strokeStyle = borderColor
      ctx.lineWidth = 1
      ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1)

      ctx.fillStyle = textColor
      ctx.fillText(label, screenPos.x, cursorY)

      cursorY += rowHeight + rowGap
    }
  })

  ctx.restore()
}

/** Render ship count labels at top-left of hexes (compact badges only, skips hovered) */
function renderShipLabels(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  hexSize: number,
  width: number,
  height: number,
  cameraState: CameraState,
  config: SectorMapConfigBase,
  ships: Map<number, ShipInfo[]> | undefined,
  hoveredSectorId: number | null = null,
  hitBoxesOut?: ShipLabelHitBox[]
) {
  if (!ships || ships.size === 0) return

  const labelStyle = config.labelStyles.shipCount
  const iconSize = 14

  ctx.save()
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"

  const labelOffset = config.sector_label_offset ?? 2
  const padding = labelStyle.padding

  ctx.font = `${labelStyle.fontWeight} ${labelStyle.fontSize}px ${getCanvasFontFamily(ctx)}`

  data.forEach((node) => {
    const shipList = ships.get(node.id)
    if (!shipList || shipList.length === 0) return

    const shipCount = shipList.length

    // Position at top-left of hex (angle 2*PI/3 = 120 degrees)
    const worldPos = hexToWorld(node.position[0], node.position[1], scale)
    const angle = (2 * Math.PI) / 3
    const edgeWorldX = worldPos.x + hexSize * Math.cos(angle)
    const edgeWorldY = worldPos.y + hexSize * Math.sin(angle)

    const screenPos = worldToScreen(edgeWorldX, edgeWorldY, width, height, cameraState)

    // Calculate text metrics
    const text = shipCount.toString()
    const textMetrics = ctx.measureText(text)
    const textWidth = textMetrics.width
    const ascent =
      textMetrics.fontBoundingBoxAscent ??
      textMetrics.actualBoundingBoxAscent ??
      labelStyle.fontSize
    const descent = textMetrics.fontBoundingBoxDescent ?? textMetrics.actualBoundingBoxDescent ?? 0
    const textHeight = ascent + descent

    // Total width: icon + gap + text
    const iconGap = 2
    const totalWidth = iconSize + iconGap + textWidth

    // Position label to the left of the edge point (anchor at right edge)
    const labelX = screenPos.x - labelOffset
    const labelY = screenPos.y

    // Recorded even for the hovered sector so hover stays sticky when the
    // label is replaced by the tooltip.
    if (hitBoxesOut) {
      hitBoxesOut.push({
        sectorId: node.id,
        x: labelX - totalWidth - padding,
        y: labelY - ascent - padding,
        w: totalWidth + padding * 2,
        h: textHeight + padding * 2,
      })
    }

    // Skip drawing for hovered sector — tooltip drawn by renderShipTooltip
    if (node.id === hoveredSectorId) return

    const labelOpacity = 1

    ctx.save()
    ctx.translate(labelX, labelY)

    // Draw background (offset to left from anchor)
    ctx.fillStyle = applyAlpha(labelStyle.backgroundColor, labelOpacity)
    ctx.fillRect(
      -totalWidth - padding,
      -ascent - padding,
      totalWidth + padding * 2,
      textHeight + padding * 2
    )

    // Draw ship icon
    ctx.save()
    ctx.translate(-totalWidth, -ascent + (textHeight - iconSize) / 2)
    const iconScale = iconSize / SHIP_ICON_VIEWBOX
    ctx.scale(iconScale, iconScale)
    ctx.fillStyle = applyAlpha(labelStyle.textColor, labelOpacity)
    ctx.fill(shipPath)
    ctx.restore()

    // Draw count text
    ctx.fillStyle = applyAlpha(labelStyle.textColor, labelOpacity)
    ctx.fillText(text, -textWidth, 0)
    ctx.restore()
  })

  ctx.restore()
}

/** Render expanded ship tooltip for the hovered sector */
function renderShipTooltip(
  ctx: CanvasRenderingContext2D,
  data: MapData,
  scale: number,
  hexSize: number,
  width: number,
  height: number,
  cameraState: CameraState,
  config: SectorMapConfigBase,
  ships: Map<number, ShipInfo[]> | undefined,
  hoveredSectorId: number | null = null
) {
  if (!ships || ships.size === 0 || hoveredSectorId === null) return

  const shipList = ships.get(hoveredSectorId)
  if (!shipList || shipList.length === 0) return

  const hoveredNode = data.find((n) => n.id === hoveredSectorId)
  if (!hoveredNode) return

  const labelStyle = config.labelStyles.shipCount
  const fontSize = 10
  const iconSize = 12
  const iconGap = 4
  const maxNameWidth = 110
  const rowHeight = fontSize + 6
  const padding = 7
  const arrowSize = 6
  const borderColor = labelStyle.backgroundColor
  const bgColor = "rgba(0,0,0,0.92)"
  const textColor = "#ffffff"
  const labelOffset = config.sector_label_offset ?? 2

  // Anchor point: top-left hex edge
  const worldPos = hexToWorld(hoveredNode.position[0], hoveredNode.position[1], scale)
  const angle = (2 * Math.PI) / 3
  const edgeWorldX = worldPos.x + hexSize * Math.cos(angle)
  const edgeWorldY = worldPos.y + hexSize * Math.sin(angle)
  const anchorPos = worldToScreen(edgeWorldX, edgeWorldY, width, height, cameraState)

  const anchorX = anchorPos.x - labelOffset
  const anchorY = anchorPos.y

  ctx.save()
  ctx.font = `${labelStyle.fontWeight} ${fontSize}px ${getCanvasFontFamily(ctx)}`
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"

  // Measure actual max text width needed (uppercase)
  let measuredMaxWidth = 0
  for (const ship of shipList) {
    const w = ctx.measureText(ship.ship_name.toUpperCase()).width
    measuredMaxWidth = Math.max(measuredMaxWidth, Math.min(w, maxNameWidth))
  }

  const tooltipWidth = padding * 2 + iconSize + iconGap + measuredMaxWidth
  const tooltipHeight = padding * 2 + shipList.length * rowHeight - 2

  // Position tooltip: to the left of anchor, arrow on right-middle side pointing to anchor
  let boxX = anchorX - tooltipWidth - arrowSize
  let boxY = anchorY - tooltipHeight / 2

  // Clamp to canvas bounds
  if (boxX < 4) boxX = 4
  if (boxY < 4) boxY = 4
  if (boxY + tooltipHeight > height - 4) boxY = height - 4 - tooltipHeight

  // Arrow tip points at anchor, base on right edge of box
  const arrowBaseX = boxX + tooltipWidth
  const arrowTipX = arrowBaseX + arrowSize
  // Keep arrow vertically centered on anchor but clamped to box edges
  let arrowMidY = anchorY
  arrowMidY = Math.max(arrowMidY, boxY + arrowSize)
  arrowMidY = Math.min(arrowMidY, boxY + tooltipHeight - arrowSize)

  // Draw tooltip background (sharp corners)
  ctx.fillStyle = bgColor
  ctx.beginPath()
  ctx.rect(boxX, boxY, tooltipWidth, tooltipHeight)
  ctx.fill()

  // Draw border
  ctx.strokeStyle = borderColor
  ctx.lineWidth = 1
  ctx.stroke()

  // Draw arrow on right-middle side
  ctx.beginPath()
  ctx.moveTo(arrowTipX, arrowMidY)
  ctx.lineTo(arrowBaseX, arrowMidY - arrowSize)
  ctx.lineTo(arrowBaseX, arrowMidY + arrowSize)
  ctx.closePath()
  ctx.fillStyle = bgColor
  ctx.fill()
  ctx.strokeStyle = borderColor
  ctx.lineWidth = 1
  ctx.stroke()

  // Erase the border line where arrow meets box
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(arrowBaseX, arrowMidY - arrowSize + 1)
  ctx.lineTo(arrowBaseX, arrowMidY + arrowSize - 1)
  ctx.strokeStyle = bgColor
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.restore()

  // Draw each ship row
  shipList.forEach((ship, index) => {
    const rowY = boxY + padding + index * rowHeight + fontSize
    const rowX = boxX + padding

    // Draw ship icon
    ctx.save()
    ctx.translate(rowX, rowY - fontSize + (rowHeight - iconSize) / 2)
    const iScale = iconSize / SHIP_ICON_VIEWBOX
    ctx.scale(iScale, iScale)
    ctx.fillStyle = textColor
    ctx.fill(shipPath)
    ctx.restore()

    // Draw truncated ship name
    const displayName = truncateText(ctx, ship.ship_name.toUpperCase(), measuredMaxWidth)
    ctx.fillStyle = textColor
    ctx.fillText(displayName, rowX + iconSize + iconGap, rowY)
  })

  ctx.restore()
}

/** Set up canvas for rendering: apply DPR scaling, guard dimensions, clear pixels.
 *  Returns the configured 2d context, or null if unavailable. */
function setupCanvas(
  canvas: HTMLCanvasElement,
  props: SectorMapProps,
  width: number,
  height: number
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d")
  if (!ctx) return null

  const dpr = window.devicePixelRatio || 1
  const targetW = props.physicalWidth ?? Math.round(width * dpr)
  const targetH = props.physicalHeight ?? Math.round(height * dpr)
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW
    canvas.height = targetH
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return ctx
}

/** Render the empty/no-data state: background, hex grid, and feather mask */
function renderEmptyState(
  canvas: HTMLCanvasElement,
  props: SectorMapProps,
  width: number,
  height: number,
  scale: number,
  hexSize: number,
  config: SectorMapConfigBase
) {
  const ctx = setupCanvas(canvas, props, width, height)
  if (!ctx) return

  ctx.fillStyle = config.uiStyles.background.color
  ctx.fillRect(0, 0, width, height)

  if (config.show_grid) {
    renderHexGridCached(ctx, width, height, 1, 0, 0, scale, hexSize, config.uiStyles.grid)
  }

  const feather = Math.min(config.uiStyles.edgeFeather.size, Math.min(width, height) / 2)
  applyRectangularFeatherMask(ctx, width, height, feather, config.uiStyles.edgeFeather.falloff)
}

/** Render animated arrows on course plot lanes only */
function renderCoursePlotAnimation(
  canvas: HTMLCanvasElement,
  props: SectorMapProps,
  cameraState: CameraState,
  animationOffset: number
) {
  const { width, height, config, coursePlot } = props
  if (!coursePlot) return

  const ctx = canvas.getContext("2d")
  if (!ctx) return

  const { hexSize, scale } = getGridMetrics(config, width, height)

  const sectorIndex = createSectorIndex(cameraState.filteredData)

  const animStyle = config.laneStyles.coursePlotAnimation

  ctx.save()
  ctx.translate(width / 2, height / 2)
  ctx.scale(cameraState.zoom, cameraState.zoom)
  ctx.translate(cameraState.offsetX, cameraState.offsetY)

  if (animStyle.shadowBlur > 0 && animStyle.shadowColor !== "none") {
    ctx.shadowBlur = animStyle.shadowBlur
    ctx.shadowColor = animStyle.shadowColor
  }
  ctx.strokeStyle = animStyle.color
  ctx.lineWidth = animStyle.width
  ctx.lineCap = animStyle.lineCap
  if (animStyle.dashPattern !== "none") {
    ctx.setLineDash(animStyle.dashPattern.split(",").map((n) => parseFloat(n)))
  }
  ctx.lineDashOffset = -animationOffset

  for (let i = 0; i < coursePlot.path.length - 1; i++) {
    const fromId = coursePlot.path[i]
    const toId = coursePlot.path[i + 1]

    const fromNode = sectorIndex.get(fromId)
    const toNode = sectorIndex.get(toId)

    if (!fromNode || !toNode) continue

    const fromCenter = hexToWorld(fromNode.position[0], fromNode.position[1], scale)
    const toCenter = hexToWorld(toNode.position[0], toNode.position[1], scale)

    const from = getHexEdgePoint(fromCenter, toCenter, hexSize)
    const to = getHexEdgePoint(toCenter, fromCenter, hexSize)

    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }

  ctx.restore()
}

/** Core rendering with explicit camera state and interaction state */
function renderWithCameraStateAndInteraction(
  canvas: HTMLCanvasElement,
  props: SectorMapProps,
  cameraState: CameraState,
  hoveredSectorId: number | null,
  animatingSectorId: number | null,
  hoverScale: number,
  courseAnimationOffset = 0,
  shipLabelHitBoxesOut?: ShipLabelHitBox[]
) {
  const { width, height, config, coursePlot, ships, corp_member_ships } = props
  const ctx = setupCanvas(canvas, props, width, height)
  if (!ctx) return

  if (shipLabelHitBoxesOut) shipLabelHitBoxesOut.length = 0

  ctx.fillStyle = config.uiStyles.background.color
  ctx.fillRect(0, 0, width, height)

  const { hexSize, scale } = getGridMetrics(config, width, height)

  const coursePlotSectors = coursePlot ? new Set(coursePlot.path) : null
  const coursePlotLanes =
    coursePlot ?
      new Set(
        coursePlot.path.slice(0, -1).map((from, i) => {
          const to = coursePlot.path[i + 1]
          return getUndirectedLaneKey(from, to)
        })
      )
    : null

  ctx.save()
  ctx.translate(width / 2, height / 2)
  ctx.scale(cameraState.zoom, cameraState.zoom)
  ctx.translate(cameraState.offsetX, cameraState.offsetY)

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
    )
  }

  renderSectorGlows(
    ctx,
    cameraState.filteredData,
    scale,
    config,
    1,
    coursePlotSectors,
    hoveredSectorId
  )

  renderCorpMemberGlows(ctx, cameraState.filteredData, scale, config, corp_member_ships)

  ctx.restore()

  const featherSize = Math.min(config.uiStyles.edgeFeather.size, Math.min(width, height) / 2)
  applyRectangularFeatherMask(ctx, width, height, featherSize, config.uiStyles.edgeFeather.falloff)

  ctx.save()
  ctx.translate(width / 2, height / 2)
  ctx.scale(cameraState.zoom, cameraState.zoom)
  ctx.translate(cameraState.offsetX, cameraState.offsetY)

  if (config.show_warps) {
    renderAllLanes(
      ctx,
      cameraState.filteredData,
      props.data,
      scale,
      hexSize,
      config,
      coursePlotLanes,
      coursePlot
    )
  }

  const fadingInIds = new Set(cameraState.fadingInData?.map((s) => s.id) ?? [])

  if (cameraState.fadingOutData && cameraState.fadeProgress !== undefined) {
    const fadeOpacity = 1 - cameraState.fadeProgress
    cameraState.fadingOutData.forEach((node) => {
      renderSector(
        ctx,
        node,
        scale,
        hexSize,
        config,
        fadeOpacity,
        coursePlotSectors,
        hoveredSectorId,
        animatingSectorId,
        hoverScale
      )
    })
  }

  cameraState.filteredData.forEach((node) => {
    const opacity =
      fadingInIds.has(node.id) && cameraState.fadeProgress !== undefined ?
        cameraState.fadeProgress
      : 1
    renderSector(
      ctx,
      node,
      scale,
      hexSize,
      config,
      opacity,
      coursePlotSectors,
      hoveredSectorId,
      animatingSectorId,
      hoverScale
    )
  })

  // Render offset frames on top of all sectors (e.g. current sector frame)
  renderSectorOffsetFrames(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    config,
    coursePlotSectors,
    hoveredSectorId,
    animatingSectorId,
    hoverScale
  )

  if (config.debug) {
    renderDebugBounds(ctx, cameraState.filteredData, scale, hexSize)
  }

  ctx.restore()

  if (coursePlot && courseAnimationOffset !== undefined) {
    renderCoursePlotAnimation(canvas, props, cameraState, courseAnimationOffset)
  }

  if (coursePlot) {
    renderCoursePlotBadges(ctx, scale, hexSize, width, height, cameraState, coursePlot)
  }
  renderShipLabels(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    width,
    height,
    cameraState,
    config,
    ships,
    hoveredSectorId,
    shipLabelHitBoxesOut
  )
  renderCorpMemberLabels(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    width,
    height,
    cameraState,
    config,
    corp_member_ships
  )
  renderPortLabels(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    width,
    height,
    cameraState,
    config,
    hoveredSectorId
  )
  renderSectorLabels(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    width,
    height,
    cameraState,
    config,
    hoveredSectorId
  )
  renderShipTooltip(
    ctx,
    cameraState.filteredData,
    scale,
    hexSize,
    width,
    height,
    cameraState,
    config,
    ships,
    hoveredSectorId
  )
}

export interface SectorMapController {
  render: () => void
  moveToSector: (newSectorId: number, newMapData?: MapData) => void
  getCurrentState: () => CameraState | null
  updateProps: (newProps: Partial<SectorMapProps>) => void
  startCourseAnimation: () => void
  stopCourseAnimation: () => void
  setOnNodeClick: (callback: ((node: MapSectorNode | null) => void) | null) => void
  setOnNodeEnter: (callback: ((node: MapSectorNode) => void) | null) => void
  setOnNodeExit: (callback: ((node: MapSectorNode) => void) | null) => void
  setOnViewportChange: (callback: ((centerSectorId: number, bounds: number) => void) | null) => void
  resetView: () => void
  cleanup: () => void
}

/** Create minimap controller with imperative API */
export function createSectorMapController(
  canvas: HTMLCanvasElement,
  props: SectorMapProps
): SectorMapController {
  let currentCameraState: CameraState | null = null
  let currentProps = { ...props }
  let animationCleanup: (() => void) | null = null
  let animationCompletionTimeout: number | null = null
  let courseAnimationFrameId: number | null = null
  let courseAnimationOffset = 0

  let hoveredSectorId: number | null = null
  const shipLabelHitBoxes: ShipLabelHitBox[] = []
  let onNodeClickCallback: ((node: MapSectorNode | null) => void) | null = null
  let onNodeEnterCallback: ((node: MapSectorNode) => void) | null = null
  let onNodeExitCallback: ((node: MapSectorNode) => void) | null = null
  let onViewportChangeCallback: ((centerSectorId: number, bounds: number) => void) | null = null
  let viewportChangeTimeoutId: number | null = null

  let animatingSectorId: number | null = null
  let hoverAnimationProgress = 0
  let hoverAnimationTarget = 0
  let hoverAnimationStartTime: number | null = null
  let hoverAnimationStartProgress = 0
  let hoverAnimationFrameId: number | null = null

  let isMovingToSector = false

  let userOverrodeCoursePlotZoom = false

  let manualPanX = 0
  let manualPanY = 0
  let manualZoomFactor = 1

  let isDragging = false
  let dragStartX = 0
  let dragStartY = 0
  let suppressNextClick = false

  /** Reset manual pan/zoom offsets to defaults */
  const resetManualOffsets = () => {
    manualPanX = 0
    manualPanY = 0
    manualZoomFactor = 1
  }

  /** Apply manual offsets to a computed camera state, expanding spatial
   *  filtering so sectors visible at the panned/zoomed position appear. */
  let lastEffectiveFilterKey = ""
  let lastEffectiveFilteredData: MapData | null = null

  const getEffectiveCameraState = (camera: CameraState): CameraState => {
    if (manualPanX === 0 && manualPanY === 0 && manualZoomFactor === 1) return camera
    const baseZoom = camera.zoom
    const minZoom = currentProps.config.minZoom ?? 0.08
    const maxZoom = currentProps.config.maxZoom ?? 5
    const effectiveZoom = Math.max(minZoom, Math.min(baseZoom * manualZoomFactor, maxZoom))
    const effectiveOffsetX = camera.offsetX + manualPanX
    const effectiveOffsetY = camera.offsetY + manualPanY

    // Re-filter data around the effective camera center so panned/zoomed
    // sectors appear. Cached to avoid re-filtering every animation frame.
    const filterKey = `${manualPanX},${manualPanY},${manualZoomFactor}`
    let filteredData: MapData
    if (filterKey === lastEffectiveFilterKey && lastEffectiveFilteredData) {
      filteredData = lastEffectiveFilteredData
    } else {
      const { width, height, data, config } = currentProps
      const scale = config.grid_spacing ?? 28

      // Effective camera center in world space (camera offsets are negated)
      const centerWorldScaled = { x: -effectiveOffsetX, y: -effectiveOffsetY }

      // Visible radius in hex units, with padding to avoid popping at edges
      const visibleWorldW = width / effectiveZoom
      const visibleWorldH = height / effectiveZoom
      const visibleRadius = Math.max(visibleWorldW, visibleWorldH) / 2
      const hexRadius = Math.ceil((visibleRadius / (scale * Math.sqrt(3))) * 1.5)

      filteredData = filterSectorsBySpatialDistance(
        data,
        config.center_sector_id,
        hexRadius,
        scale,
        centerWorldScaled,
        width,
        height
      )
      lastEffectiveFilterKey = filterKey
      lastEffectiveFilteredData = filteredData
    }

    return {
      ...camera,
      offsetX: effectiveOffsetX,
      offsetY: effectiveOffsetY,
      zoom: effectiveZoom,
      filteredData,
    }
  }

  const getCanvasMousePosition = (event: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    const logicalWidth = canvas.width / dpr
    const logicalHeight = canvas.height / dpr

    const boxAspect = rect.width / rect.height
    const contentAspect = logicalWidth / logicalHeight

    let contentWidth: number
    let contentHeight: number
    let offsetX = 0
    let offsetY = 0

    if (boxAspect > contentAspect) {
      contentHeight = rect.height
      contentWidth = rect.height * contentAspect
      offsetX = (rect.width - contentWidth) / 2
    } else {
      contentWidth = rect.width
      contentHeight = rect.width / contentAspect
      offsetY = (rect.height - contentHeight) / 2
    }

    const contentRelativeX = event.clientX - rect.left - offsetX
    const contentRelativeY = event.clientY - rect.top - offsetY

    const scaleX = logicalWidth / contentWidth
    const scaleY = logicalHeight / contentHeight

    return {
      x: contentRelativeX * scaleX,
      y: contentRelativeY * scaleY,
    }
  }

  const findSectorAtMouse = (screenX: number, screenY: number): MapSectorNode | null => {
    if (!currentCameraState) return null

    const { width, height, config } = currentProps
    const { hexSize, scale } = getGridMetrics(config, width, height)

    const effective = getEffectiveCameraState(currentCameraState)
    const worldPos = screenToWorld(screenX, screenY, width, height, effective)
    return findSectorAtPoint(worldPos.x, worldPos.y, effective.filteredData, scale, hexSize)
  }

  const startHoverAnimation = () => {
    if (hoverAnimationFrameId !== null) return

    const animateHover = (currentTime: number) => {
      if (hoverAnimationStartTime === null) {
        hoverAnimationStartTime = currentTime
      }

      const elapsed = currentTime - hoverAnimationStartTime
      const animationDuration = currentProps.config.hover_animation_duration ?? 150
      const progress = Math.min(elapsed / animationDuration, 1)
      const easedProgress = easeInOutCubic(progress)

      hoverAnimationProgress =
        hoverAnimationStartProgress +
        (hoverAnimationTarget - hoverAnimationStartProgress) * easedProgress

      if (currentCameraState) {
        renderWithInteractionState()
      }

      if (progress < 1) {
        hoverAnimationFrameId = requestAnimationFrame(animateHover)
      } else {
        hoverAnimationFrameId = null
        hoverAnimationStartTime = null
        if (hoverAnimationTarget === 0) {
          animatingSectorId = null
        }
      }
    }

    hoverAnimationFrameId = requestAnimationFrame(animateHover)
  }

  const stopHoverAnimation = () => {
    if (hoverAnimationFrameId !== null) {
      cancelAnimationFrame(hoverAnimationFrameId)
      hoverAnimationFrameId = null
      hoverAnimationStartTime = null
    }
  }

  const setHoverTarget = (target: number, sectorId: number | null) => {
    if (target === 1 && sectorId !== null) {
      animatingSectorId = sectorId
    }
    if (hoverAnimationTarget === target && animatingSectorId === sectorId) return

    hoverAnimationStartProgress = hoverAnimationProgress
    hoverAnimationTarget = target
    hoverAnimationStartTime = null
    startHoverAnimation()
  }

  const findSectorAtShipLabel = (screenX: number, screenY: number): MapSectorNode | null => {
    if (!currentCameraState || shipLabelHitBoxes.length === 0) return null
    // Walk in reverse so later-drawn labels take precedence on overlap
    for (let i = shipLabelHitBoxes.length - 1; i >= 0; i--) {
      const box = shipLabelHitBoxes[i]
      if (
        screenX >= box.x &&
        screenX <= box.x + box.w &&
        screenY >= box.y &&
        screenY <= box.y + box.h
      ) {
        return currentCameraState.filteredData.find((s) => s.id === box.sectorId) ?? null
      }
    }
    return null
  }

  const handleMouseMove = (event: MouseEvent) => {
    if (!currentProps.config.hoverable || isMovingToSector) return

    const pos = getCanvasMousePosition(event)
    // Ship label hit-boxes take precedence so the expanded tooltip stays sticky
    // when it overlaps neighboring hexes; also makes icons hoverable when the
    // map is zoomed out and hexes are smaller than the ship-count badge.
    const sector = findSectorAtShipLabel(pos.x, pos.y) ?? findSectorAtMouse(pos.x, pos.y)
    const newHoveredId = sector?.id ?? null

    if (newHoveredId !== hoveredSectorId) {
      const previousHoveredId = hoveredSectorId
      hoveredSectorId = newHoveredId

      if (previousHoveredId !== null && onNodeExitCallback) {
        const exitedSector = currentCameraState?.filteredData.find(
          (s) => s.id === previousHoveredId
        )
        if (exitedSector) {
          onNodeExitCallback(exitedSector)
        }
      }

      if (sector !== null && onNodeEnterCallback) {
        onNodeEnterCallback(sector)
      }

      if (newHoveredId !== null) {
        setHoverTarget(1, newHoveredId)
      } else if (previousHoveredId !== null) {
        setHoverTarget(0, previousHoveredId)
      }

      canvas.style.cursor = newHoveredId !== null ? "pointer" : "default"
    }
  }

  const handleMouseClick = (event: MouseEvent) => {
    if (suppressNextClick) {
      suppressNextClick = false
      return
    }
    if (!currentProps.config.clickable || isMovingToSector) return

    const pos = getCanvasMousePosition(event)
    const sector = findSectorAtShipLabel(pos.x, pos.y) ?? findSectorAtMouse(pos.x, pos.y)

    if (onNodeClickCallback) {
      onNodeClickCallback(sector)
    }
  }

  const handleMouseLeave = () => {
    if (isDragging) return
    if (!currentProps.config.hoverable || isMovingToSector) return

    if (hoveredSectorId !== null) {
      const previousHoveredId = hoveredSectorId

      if (onNodeExitCallback) {
        const exitedSector = currentCameraState?.filteredData.find(
          (s) => s.id === previousHoveredId
        )
        if (exitedSector) {
          onNodeExitCallback(exitedSector)
        }
      }

      hoveredSectorId = null
      setHoverTarget(0, previousHoveredId)
      canvas.style.cursor = "default"
    }
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (!currentProps.config.draggable || isMovingToSector) return
    isDragging = false
    dragStartX = event.clientX
    dragStartY = event.clientY
    canvas.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (!currentProps.config.draggable || isMovingToSector) return
    if (!canvas.hasPointerCapture(event.pointerId)) return

    const events = event.getCoalescedEvents?.() ?? [event]

    for (const e of events) {
      const dx = e.clientX - dragStartX
      const dy = e.clientY - dragStartY

      if (!isDragging && Math.abs(dx) < 3 && Math.abs(dy) < 3) continue

      if (!isDragging) {
        isDragging = true
        if (hoveredSectorId !== null) {
          const prevId = hoveredSectorId
          hoveredSectorId = null
          setHoverTarget(0, prevId)
        }
        canvas.style.cursor = "grabbing"
      }

      if (currentCameraState) {
        const effectiveZoom = getEffectiveCameraState(currentCameraState).zoom
        manualPanX += dx / effectiveZoom
        manualPanY += dy / effectiveZoom
      }

      dragStartX = e.clientX
      dragStartY = e.clientY
    }

    if (isDragging) {
      renderWithInteractionState()
    }
  }

  const handlePointerUp = (event: PointerEvent) => {
    if (!currentProps.config.draggable) return
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    if (isDragging) {
      isDragging = false
      suppressNextClick = true
      canvas.style.cursor = "default"
      scheduleViewportChange()
    }
  }

  const handleWheel = (event: WheelEvent) => {
    if (!currentProps.config.scrollZoom || isMovingToSector || !currentCameraState) return
    event.preventDefault()

    if (currentProps.coursePlot && currentProps.config.coursePlotZoomEnabled !== false) {
      userOverrodeCoursePlotZoom = true
    }

    const zoomSensitivity = 0.005
    const zoomDelta = 1 - event.deltaY * zoomSensitivity
    const oldEffective = getEffectiveCameraState(currentCameraState)

    const minZoom = currentProps.config.minZoom ?? 0.08
    const maxZoom = currentProps.config.maxZoom ?? 5
    const newZoom = Math.max(minZoom, Math.min(oldEffective.zoom * zoomDelta, maxZoom))
    manualZoomFactor = newZoom / currentCameraState.zoom

    const { width, height } = currentProps
    const pos = getCanvasMousePosition(event as unknown as MouseEvent)
    const screenX = pos.x
    const screenY = pos.y

    const worldX = (screenX - width / 2) / oldEffective.zoom - oldEffective.offsetX
    const worldY = (screenY - height / 2) / oldEffective.zoom - oldEffective.offsetY

    manualPanX = (screenX - width / 2) / newZoom - currentCameraState.offsetX - worldX
    manualPanY = (screenY - height / 2) / newZoom - currentCameraState.offsetY - worldY

    renderWithInteractionState()
    scheduleViewportChange()
  }

  const attachEventListeners = () => {
    canvas.addEventListener("mousemove", handleMouseMove)
    canvas.addEventListener("click", handleMouseClick)
    canvas.addEventListener("mouseleave", handleMouseLeave)
    canvas.addEventListener("pointerdown", handlePointerDown)
    canvas.addEventListener("pointermove", handlePointerMove)
    canvas.addEventListener("pointerup", handlePointerUp)
    canvas.addEventListener("wheel", handleWheel, { passive: false })
  }

  const detachEventListeners = () => {
    canvas.removeEventListener("mousemove", handleMouseMove)
    canvas.removeEventListener("click", handleMouseClick)
    canvas.removeEventListener("mouseleave", handleMouseLeave)
    canvas.removeEventListener("pointerdown", handlePointerDown)
    canvas.removeEventListener("pointermove", handlePointerMove)
    canvas.removeEventListener("pointerup", handlePointerUp)
    canvas.removeEventListener("wheel", handleWheel)
    canvas.style.cursor = "default"
  }

  const renderWithInteractionState = () => {
    if (!currentCameraState) return

    const scaleFactor = currentProps.config.hover_scale_factor ?? 1.15
    const hoverScale = 1 + (scaleFactor - 1) * hoverAnimationProgress

    renderWithCameraStateAndInteraction(
      canvas,
      currentProps,
      getEffectiveCameraState(currentCameraState),
      hoveredSectorId,
      animatingSectorId,
      hoverScale,
      courseAnimationOffset,
      shipLabelHitBoxes
    )
  }

  const render = () => {
    const { width, height, data, config, maxDistance = 3, coursePlot } = currentProps
    const { hexSize, scale } = getGridMetrics(config, width, height)

    const coursePlotForCamera =
      config.coursePlotZoomEnabled !== false && !userOverrodeCoursePlotZoom ? coursePlot : undefined

    const cameraState = calculateCameraState(
      data,
      config,
      width,
      height,
      scale,
      hexSize,
      maxDistance,
      coursePlotForCamera
    )

    if (!cameraState) {
      renderEmptyState(canvas, currentProps, width, height, scale, hexSize, config)
      return
    }

    if (manualZoomFactor !== 1 && currentCameraState && cameraState.zoom > 0) {
      const prevEffectiveZoom = getEffectiveCameraState(currentCameraState).zoom
      manualZoomFactor = prevEffectiveZoom / cameraState.zoom
    }

    currentCameraState = cameraState

    const scaleFactor = currentProps.config.hover_scale_factor ?? 1.15
    const hoverScale = 1 + (scaleFactor - 1) * hoverAnimationProgress

    renderWithCameraStateAndInteraction(
      canvas,
      currentProps,
      getEffectiveCameraState(cameraState),
      hoveredSectorId,
      animatingSectorId,
      hoverScale,
      courseAnimationOffset,
      shipLabelHitBoxes
    )
  }

  const animateCameraReframe = (onComplete?: () => void, targetZoomOverride?: number) => {
    if (animationCleanup) {
      animationCleanup()
      animationCleanup = null
    }
    if (animationCompletionTimeout !== null) {
      window.clearTimeout(animationCompletionTimeout)
      animationCompletionTimeout = null
    }

    const { width, height, data, config, maxDistance = 3, coursePlot } = currentProps
    const { hexSize, scale } = getGridMetrics(config, width, height)

    const coursePlotForCamera =
      config.coursePlotZoomEnabled !== false && !userOverrodeCoursePlotZoom ? coursePlot : undefined

    const targetCameraState = calculateCameraState(
      data,
      config,
      width,
      height,
      scale,
      hexSize,
      maxDistance,
      coursePlotForCamera
    )

    if (!targetCameraState || !currentCameraState || config.bypass_animation) {
      resetManualOffsets()
      render()
      onComplete?.()
      return
    }

    if (targetZoomOverride !== undefined) {
      targetCameraState.zoom = targetZoomOverride
    }

    const effectiveStart = getEffectiveCameraState(currentCameraState)
    resetManualOffsets()

    const currentDataIds = new Set(effectiveStart.filteredData.map((s) => s.id))
    const targetDataIds = new Set(targetCameraState.filteredData.map((s) => s.id))
    const fadingOutData = effectiveStart.filteredData.filter((s) => !targetDataIds.has(s.id))
    const fadingInData = targetCameraState.filteredData.filter((s) => !currentDataIds.has(s.id))

    const startCameraWithFade: CameraState = {
      offsetX: effectiveStart.offsetX,
      offsetY: effectiveStart.offsetY,
      zoom: effectiveStart.zoom,
      filteredData: targetCameraState.filteredData,
      fadingOutData,
      fadingInData,
      fadeProgress: 0,
    }

    const panDuration = config.animation_duration_pan
    const zoomDuration = config.animation_duration_zoom
    const fadeDuration = Math.max(panDuration, zoomDuration)

    const animationState: AnimationState = {
      isAnimating: true,
      startTime: performance.now(),
      panDuration,
      zoomDuration,
      fadeDuration,
      startCamera: startCameraWithFade,
      targetCamera: targetCameraState,
    }

    const animate = (currentTime: number) => {
      if (!animationState.isAnimating) return

      const elapsed = currentTime - animationState.startTime
      const panProgress = Math.min(elapsed / animationState.panDuration, 1)
      const zoomProgress = Math.min(elapsed / animationState.zoomDuration, 1)
      const fadeProgress = Math.min(elapsed / animationState.fadeDuration, 1)

      const interpolatedCamera = interpolateCameraState(
        animationState.startCamera,
        animationState.targetCamera,
        panProgress,
        zoomProgress,
        fadeProgress
      )

      if (currentProps.coursePlot) {
        courseAnimationOffset = (courseAnimationOffset + 0.5) % 20
      }

      renderWithCameraStateAndInteraction(
        canvas,
        currentProps,
        interpolatedCamera,
        null,
        null,
        1,
        courseAnimationOffset,
        shipLabelHitBoxes
      )

      if (fadeProgress < 1) {
        animationState.animationFrameId = requestAnimationFrame(animate)
      } else {
        animationState.isAnimating = false
        currentCameraState = targetCameraState
        animationCleanup = null
        onComplete?.()
      }
    }

    animationState.animationFrameId = requestAnimationFrame(animate)

    animationCleanup = () => {
      animationState.isAnimating = false
      if (animationState.animationFrameId !== undefined) {
        cancelAnimationFrame(animationState.animationFrameId)
      }
    }
  }

  const moveToSector = (newSectorId: number, newMapData?: MapData) => {
    if (animationCleanup) {
      animationCleanup()
      animationCleanup = null
    }
    if (animationCompletionTimeout !== null) {
      window.clearTimeout(animationCompletionTimeout)
      animationCompletionTimeout = null
    }

    isMovingToSector = true

    if (hoveredSectorId !== null || animatingSectorId !== null) {
      hoveredSectorId = null
      animatingSectorId = null
      hoverAnimationProgress = 0
      hoverAnimationTarget = 0
      stopHoverAnimation()
    }
    canvas.style.cursor = "default"

    const wasAnimating = courseAnimationFrameId !== null
    if (wasAnimating) {
      stopCourseAnimation()
    }

    const updatedProps = {
      ...currentProps,
      data: newMapData ?? currentProps.data,
      config: { ...currentProps.config, center_sector_id: newSectorId },
    }
    currentProps = updatedProps

    if (currentCameraState) {
      const effectiveStart = getEffectiveCameraState(currentCameraState)
      const coursePlotControlsCamera =
        !!updatedProps.coursePlot &&
        updatedProps.config.coursePlotZoomEnabled !== false &&
        !userOverrodeCoursePlotZoom
      const hadManualZoom = manualZoomFactor !== 1 && !coursePlotControlsCamera
      const preservedZoom = hadManualZoom ? effectiveStart.zoom : undefined
      resetManualOffsets()

      const animationProps =
        userOverrodeCoursePlotZoom ?
          { ...updatedProps, config: { ...updatedProps.config, coursePlotZoomEnabled: false } }
        : updatedProps
      animationCleanup = updateCurrentSector(
        canvas,
        animationProps,
        newSectorId,
        effectiveStart,
        preservedZoom
      )

      const animDuration = Math.max(
        updatedProps.config.animation_duration_pan,
        updatedProps.config.animation_duration_zoom
      )

      animationCompletionTimeout = window.setTimeout(() => {
        currentCameraState = getCurrentCameraState(
          userOverrodeCoursePlotZoom ?
            { ...updatedProps, config: { ...updatedProps.config, coursePlotZoomEnabled: false } }
          : updatedProps
        )
        if (hadManualZoom && currentCameraState && preservedZoom !== undefined) {
          manualZoomFactor = preservedZoom / currentCameraState.zoom
        }
        animationCleanup = null
        animationCompletionTimeout = null
        isMovingToSector = false
        if (updatedProps.coursePlot) {
          startCourseAnimation()
        }
        renderWithInteractionState()
      }, animDuration)
    } else {
      render()
      isMovingToSector = false
      if (updatedProps.coursePlot) {
        startCourseAnimation()
      }
    }
  }

  const getCurrentState = () => currentCameraState

  const updateProps = (newProps: Partial<SectorMapProps>) => {
    const hadCoursePlot = currentProps.coursePlot !== undefined && currentProps.coursePlot !== null
    const wasClickable = currentProps.config.clickable
    const wasHoverable = currentProps.config.hoverable
    const prevMaxDistance = currentProps.maxDistance

    if (newProps.data) {
      lastEffectiveFilterKey = ""
      lastEffectiveFilteredData = null
    }

    Object.assign(currentProps, newProps)
    if (newProps.config) {
      Object.assign(currentProps.config, newProps.config)
    }

    const hasCoursePlot = currentProps.coursePlot !== undefined && currentProps.coursePlot !== null

    // Reset user zoom override on course plot transitions (new plot or cleared)
    if (hasCoursePlot !== hadCoursePlot) {
      userOverrodeCoursePlotZoom = false
    }

    // Start or stop animation based on coursePlot presence
    const coursePlotZoom = currentProps.config.coursePlotZoomEnabled !== false
    if (hasCoursePlot && !hadCoursePlot) {
      // Clear hover state when course plot becomes active
      if (hoveredSectorId !== null) {
        hoveredSectorId = null
        animatingSectorId = null
        hoverAnimationProgress = 0
        hoverAnimationTarget = 0
        stopHoverAnimation()
        canvas.style.cursor = "default"
      }
      if (coursePlotZoom) {
        // Recenter to current sector when course plot becomes active (course plot takes precedence)
        if (
          currentProps.config.current_sector_id !== undefined &&
          currentProps.config.center_sector_id !== currentProps.config.current_sector_id
        ) {
          moveToSector(currentProps.config.current_sector_id)
        } else {
          animateCameraReframe(() => {
            startCourseAnimation()
          })
        }
      } else {
        render()
        startCourseAnimation()
      }
    } else if (!hasCoursePlot && hadCoursePlot) {
      stopCourseAnimation()
      if (coursePlotZoom) {
        animateCameraReframe()
      } else {
        render()
      }
    } else if (hasCoursePlot && hadCoursePlot) {
      // Course plot already active - ensure animation is running (may have been stopped by panel close/reopen)
      if (courseAnimationFrameId === null) {
        render()
        startCourseAnimation()
      }
    }

    // Animate zoom when maxDistance changes from explicit user action (slider).
    // Skip when: the change came from scroll-zoom sync, course plot just transitioned,
    // or a sector move is in progress.
    const maxDistanceChanged =
      newProps.maxDistance !== undefined && newProps.maxDistance !== prevMaxDistance
    const coursePlotTransitioned =
      (hasCoursePlot && !hadCoursePlot) || (!hasCoursePlot && hadCoursePlot)

    // Mark that the user explicitly changed zoom while a course plot is active
    if (maxDistanceChanged && hasCoursePlot && coursePlotZoom && !coursePlotTransitioned) {
      userOverrodeCoursePlotZoom = true
    }

    if (maxDistanceChanged && !coursePlotTransitioned && !isMovingToSector) {
      resetManualOffsets()
      animateCameraReframe()
    }

    // Handle clickable/hoverable config changes
    const wasInteractive = wasClickable || wasHoverable
    const isInteractive = currentProps.config.clickable || currentProps.config.hoverable
    if (isInteractive && !wasInteractive) {
      attachEventListeners()
    } else if (!isInteractive && wasInteractive) {
      detachEventListeners()
      hoveredSectorId = null
      hoverAnimationProgress = 0
      hoverAnimationTarget = 0
    }
  }

  const startCourseAnimation = () => {
    if (courseAnimationFrameId !== null) return // Already running
    if (!currentProps.coursePlot) return

    // If camera state is missing, try to render first to establish it
    if (!currentCameraState) {
      render()
      // If still no camera state after render, we can't animate
      if (!currentCameraState) return
    }

    const animate = () => {
      courseAnimationOffset = (courseAnimationOffset + 0.5) % 20

      if (currentCameraState && currentProps.coursePlot) {
        renderWithInteractionState()
      }

      courseAnimationFrameId = requestAnimationFrame(animate)
    }

    courseAnimationFrameId = requestAnimationFrame(animate)
  }

  const stopCourseAnimation = () => {
    if (courseAnimationFrameId !== null) {
      cancelAnimationFrame(courseAnimationFrameId)
      courseAnimationFrameId = null
      courseAnimationOffset = 0
    }
  }

  // New controller methods for click interaction
  const setOnNodeClick = (callback: ((node: MapSectorNode | null) => void) | null) => {
    onNodeClickCallback = callback
  }

  const setOnNodeEnter = (callback: ((node: MapSectorNode) => void) | null) => {
    onNodeEnterCallback = callback
  }

  const setOnNodeExit = (callback: ((node: MapSectorNode) => void) | null) => {
    onNodeExitCallback = callback
  }

  const setOnViewportChange = (
    callback: ((centerSectorId: number, bounds: number) => void) | null
  ) => {
    onViewportChangeCallback = callback
  }

  /** Find the sector in full data closest to a world-space point */
  const findNearestSector = (worldX: number, worldY: number): MapSectorNode | null => {
    const { data, config } = currentProps
    const scale = config.grid_spacing ?? 28
    let best: MapSectorNode | null = null
    let bestDist = Infinity
    for (const sector of data) {
      const w = hexToWorld(sector.position[0], sector.position[1], scale)
      const dx = w.x - worldX
      const dy = w.y - worldY
      const d = dx * dx + dy * dy
      if (d < bestDist) {
        bestDist = d
        best = sector
      }
    }
    return best
  }

  /**
   * Debounced handler that fires after manual pan/zoom settles.
   * Computes the visible viewport extent, finds the nearest sector to the
   * camera center, and fires onViewportChangeCallback for data fetching.
   * Does NOT update store state (no reframes) — spatial filtering is handled
   * by getEffectiveCameraState expanding filteredData around the effective camera.
   */
  const VIEWPORT_CHANGE_DEBOUNCE = 300
  const scheduleViewportChange = () => {
    if (!onViewportChangeCallback || !currentCameraState) return
    if (viewportChangeTimeoutId !== null) {
      window.clearTimeout(viewportChangeTimeoutId)
    }
    viewportChangeTimeoutId = window.setTimeout(() => {
      viewportChangeTimeoutId = null
      if (!onViewportChangeCallback || !currentCameraState) return

      const effective = getEffectiveCameraState(currentCameraState)
      const { width, height, config } = currentProps
      const scale = config.grid_spacing ?? 28

      // Camera center in world space
      const centerWorldX = -effective.offsetX
      const centerWorldY = -effective.offsetY

      // Find nearest sector to the effective camera center
      const nearest = findNearestSector(centerWorldX, centerWorldY)
      if (!nearest) return

      // Compute visible world extent → convert to hex-unit radius
      const visibleWorldW = width / effective.zoom
      const visibleWorldH = height / effective.zoom
      const visibleRadius = Math.max(visibleWorldW, visibleWorldH) / 2
      const hexRadius = visibleRadius / (scale * Math.sqrt(3))

      // Quantize to multiples of 5 to avoid jitter from floating-point variance
      const raw = Math.ceil(hexRadius * 2)
      const bounds = Math.max(0, Math.min(100, Math.ceil(raw / 5) * 5))
      onViewportChangeCallback(nearest.id, bounds)
    }, VIEWPORT_CHANGE_DEBOUNCE)
  }

  const cleanup = () => {
    detachEventListeners()
    stopHoverAnimation()
    stopCourseAnimation()
    if (animationCleanup) {
      animationCleanup()
    }
    if (animationCompletionTimeout !== null) {
      window.clearTimeout(animationCompletionTimeout)
    }
    if (viewportChangeTimeoutId !== null) {
      window.clearTimeout(viewportChangeTimeoutId)
    }
  }

  render()

  // Start animation if coursePlot is already active
  // Use requestAnimationFrame to ensure the initial render is complete
  if (props.coursePlot) {
    requestAnimationFrame(() => {
      startCourseAnimation()
    })
  }

  // Attach event listeners if clickable or hoverable
  if (props.config.clickable || props.config.hoverable) {
    attachEventListeners()
  }

  return {
    render,
    moveToSector,
    getCurrentState,
    updateProps,
    startCourseAnimation,
    stopCourseAnimation,
    setOnNodeClick,
    setOnNodeEnter,
    setOnNodeExit,
    setOnViewportChange,
    resetView: () => {
      userOverrodeCoursePlotZoom = false
      resetManualOffsets()
      animateCameraReframe()
    },
    cleanup,
  }
}

/** Render minimap canvas (stateless) */
export function renderSectorMapCanvas(canvas: HTMLCanvasElement, props: SectorMapProps) {
  const { width, height, data, config, maxDistance = 3, coursePlot } = props

  const { hexSize, scale } = getGridMetrics(config, width, height)

  const coursePlotForCamera = config.coursePlotZoomEnabled !== false ? coursePlot : undefined

  const cameraState = calculateCameraState(
    data,
    config,
    width,
    height,
    scale,
    hexSize,
    maxDistance,
    coursePlotForCamera
  )

  if (!cameraState) {
    renderEmptyState(canvas, props, width, height, scale, hexSize, config)
    return
  }

  renderWithCameraStateAndInteraction(canvas, props, cameraState, null, null, 1)
}

/** Get current camera state for tracking between renders */
export function getCurrentCameraState(props: SectorMapProps): CameraState | null {
  const { width, height, data, config, maxDistance = 3, coursePlot } = props
  const { hexSize, scale } = getGridMetrics(config, width, height)
  const coursePlotForCamera = config.coursePlotZoomEnabled !== false ? coursePlot : undefined
  return calculateCameraState(
    data,
    config,
    width,
    height,
    scale,
    hexSize,
    maxDistance,
    coursePlotForCamera
  )
}

/** Animate transition to new sector */
export function updateCurrentSector(
  canvas: HTMLCanvasElement,
  props: SectorMapProps,
  newSectorId: number,
  currentCameraState: CameraState | null,
  targetZoomOverride?: number
): () => void {
  const { width, height, data, config, maxDistance = 3, coursePlot } = props

  const { hexSize, scale } = getGridMetrics(config, width, height)

  const newConfig = { ...config, center_sector_id: newSectorId }

  // Respect coursePlotZoomEnabled so that when zoom is overridden,
  // the camera uses maxDistance-based framing instead of auto-fitting
  const coursePlotForCamera = config.coursePlotZoomEnabled !== false ? coursePlot : undefined

  const targetCameraState = calculateCameraState(
    data,
    newConfig,
    width,
    height,
    scale,
    hexSize,
    maxDistance,
    coursePlotForCamera
  )

  if (!targetCameraState) {
    renderEmptyState(canvas, props, width, height, scale, hexSize, config)
    return () => {}
  }

  // Override target zoom to preserve user's manual zoom level during sector transitions
  if (targetZoomOverride !== undefined) {
    targetCameraState.zoom = targetZoomOverride
  }

  if (!currentCameraState || config.bypass_animation) {
    renderWithCameraStateAndInteraction(
      canvas,
      { ...props, config: newConfig },
      targetCameraState,
      null,
      null,
      1
    )
    return () => {}
  }

  const currentDataIds = new Set(currentCameraState.filteredData.map((s) => s.id))
  const targetDataIds = new Set(targetCameraState.filteredData.map((s) => s.id))

  const fadingOutData = currentCameraState.filteredData.filter((s) => !targetDataIds.has(s.id))
  const fadingInData = targetCameraState.filteredData.filter((s) => !currentDataIds.has(s.id))

  const startCameraWithFade: CameraState = {
    offsetX: currentCameraState.offsetX,
    offsetY: currentCameraState.offsetY,
    zoom: currentCameraState.zoom,
    filteredData: targetCameraState.filteredData,
    fadingOutData,
    fadingInData,
    fadeProgress: 0,
  }

  const panDuration = config.animation_duration_pan
  const zoomDuration = config.animation_duration_zoom
  const fadeDuration = Math.max(panDuration, zoomDuration)

  const animationState: AnimationState = {
    isAnimating: true,
    startTime: performance.now(),
    panDuration,
    zoomDuration,
    fadeDuration,
    startCamera: startCameraWithFade,
    targetCamera: targetCameraState,
  }

  const animate = (currentTime: number) => {
    if (!animationState.isAnimating) return

    const elapsed = currentTime - animationState.startTime
    const panProgress = Math.min(elapsed / animationState.panDuration, 1)
    const zoomProgress = Math.min(elapsed / animationState.zoomDuration, 1)
    const fadeProgress = Math.min(elapsed / animationState.fadeDuration, 1)

    const interpolatedCamera = interpolateCameraState(
      animationState.startCamera,
      animationState.targetCamera,
      panProgress,
      zoomProgress,
      fadeProgress
    )

    renderWithCameraStateAndInteraction(
      canvas,
      { ...props, config: newConfig },
      interpolatedCamera,
      null,
      null,
      1
    )

    if (fadeProgress < 1) {
      animationState.animationFrameId = requestAnimationFrame(animate)
    } else {
      animationState.isAnimating = false
    }
  }

  animationState.animationFrameId = requestAnimationFrame(animate)

  return () => {
    animationState.isAnimating = false
    if (animationState.animationFrameId !== undefined) {
      cancelAnimationFrame(animationState.animationFrameId)
    }
  }
}
