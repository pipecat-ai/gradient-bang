import { usePlaySound } from "@/hooks/usePlaySound";
import useGameStore from "@stores/game";
import { useEffect, useRef } from "react";

/**
 * Configuration interface for DiamondFX animation
 */
export interface DiamondFXConfig {
  /** Skip corner-to-center phase, start at center (default: false) */
  half?: boolean;
  /** Line/dash color (default: 'rgba(255,255,255,0.95)') */
  lineColor?: string;
  /** Canvas positioning mode: 'fixed' (viewport) or 'absolute' (fill parent). Default: 'fixed' */
  position?: "fixed" | "absolute";
  /** z-index for the canvas overlay (string or number). Default: 10 */
  zIndex?: number | string;
  /** Starting color at corners, fades to lineColor (default: null, same as lineColor) */
  lineStartColor?: string | null;
  /** Line width in pixels, null=auto-scale (default: null) */
  lineWidthPx?: number | null;
  /** Diamond size as fraction of viewport (default: 0.07) */
  diamondSize?: number;
  /** Number of blink cycles (default: 3) */
  blinkCount?: number;
  /** Duration of each blink cycle in ms, overrides timings.blink if set (default: null) */
  blinkDuration?: number | null;
  /** Final dash length in pixels (default: 16) */
  markerLen?: number;
  /** Distance dashes sit outside target corners (default: 12) */
  offsetPx?: number;
  /** When morph begins during inbound (default: 0.6) */
  morphDuringInStart?: number;
  /** When corner ends start retracting (default: 0.4) */
  retractStart?: number;
  /** Pause duration before blink in ms (default: 0) */
  pauseBeforeBlink?: number;
  /** When edges shrink during spin (default: 0.65) */
  shrinkStart?: number;
  /** Glow intensity multiplier, 0=none (default: 1.0) */
  shadowBlur?: number;
  /** Maximum device pixel ratio cap (default: 2.5) */
  maxDPR?: number;
  /** Spin configuration */
  spin?: {
    /** Total rotation in degrees (default: 450) */
    angleDeg?: number;
  };
  /** Phase durations in milliseconds */
  timings?: {
    in: number;
    morph: number;
    blink: number;
    spin: number;
    split: number;
    refresh?: number; // optional override for refresh duration (defaults to split)
  };
  /** Callback when animation finishes. exit=false for animate-in, exit=true for animate-out */
  onComplete?: (exit: boolean) => void;
  /** Callback after each phase */
  onPhaseComplete?: (phase: string) => void;
  /** Callback when target element removed from DOM */
  onTargetRemoved?: (targetId: string) => void;
}

/**
 * DiamondFX controller methods
 */
export interface DiamondFXController {
  /** Start animation targeting element by ID */
  start: (targetId: string, wait?: boolean, refresh?: boolean) => void;
  /** Continue from blink phase (when started with wait=true) */
  resume: () => void;
  /** Stop animation if playing, or fade out docked dashes. If animateOut=true, animates dashes back to corners */
  clear: (animateOut?: boolean) => void;
  /** Update configuration (applies to next animation) */
  update: (config: DiamondFXConfig) => void;
  /** Clean up all observers and event listeners */
  destroy: () => void;
  /** True when lines are docked to the current target and idle */
  readonly isDocked: boolean;
  /** True while any animation is active (play, refresh, fade/animate out) */
  readonly isAnimating: boolean;
}

interface AnimatedFrameProps {
  config?: DiamondFXConfig;
}

type InternalDiamondFXConfig = Required<
  Omit<DiamondFXConfig, "lineStartColor" | "lineWidthPx" | "blinkDuration">
> & {
  lineStartColor: string | null;
  lineWidthPx: number | null;
  blinkDuration: number | null;
};

const DEFAULTS: InternalDiamondFXConfig = {
  half: false,
  lineColor: "rgba(255,255,255,0.95)",
  position: "absolute",
  zIndex: 9999,
  lineStartColor: null,
  lineWidthPx: null,
  diamondSize: 0.05,
  blinkCount: 3,
  blinkDuration: null,
  markerLen: 16,
  offsetPx: 12,
  morphDuringInStart: 0.8,
  retractStart: 0.2,
  pauseBeforeBlink: 0,
  shrinkStart: 0.65,
  shadowBlur: 1.0,
  maxDPR: 2.5,
  spin: { angleDeg: 360 },
  timings: {
    in: 420,
    morph: 280,
    blink: 260,
    spin: 0,
    split: 260,
    refresh: 220,
  },
  onComplete: () => {},
  onPhaseComplete: () => {},
  onTargetRemoved: () => {},
};

/**
 * AnimatedFrame Component
 *
 * Canvas-based diamond formation animation that creates lines drawing from
 * screen corners, morphing into a diamond shape, blinking, spinning, then
 * splitting into dashes that dock at target element corners.
 *
 * Store-based version that saves the DiamondFX instance to game store.
 * Access the instance via `useGameStore.getState().diamondFXInstance`.
 *
 * @example
 * import useGameStore from '@/stores/game';
 *
 * // In your component:
 * <AnimatedFrame config={{ shadowBlur: 1.0 }} />
 *
 * // Later, to start animation:
 * const fx = useGameStore.getState().diamondFXInstance;
 * fx?.start('targetElementId');
 */
export const AnimatedFrame = ({ config = {} }: AnimatedFrameProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playSound = usePlaySound();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const state = useGameStore.getState();

    console.log("[GAME] AnimatedFrame initialized");
    if (!state.diamondFXInstance) {
      const fx = createDiamondFX(canvas, {
        onPhaseComplete(phase) {
          if (phase === "start" || phase === "exit-start") {
            playSound("chime6");
          }
          if (phase === "split" || phase === "refresh-end") {
            playSound("chime3");
          }
        },
      });
      state.setDiamondFXInstance(fx);
    }

    return () => {
      const state = useGameStore.getState();
      if (state.diamondFXInstance) {
        state.diamondFXInstance.destroy();
        state.setDiamondFXInstance(undefined);
      }
    };
  }, [playSound]);

  useEffect(() => {
    const state = useGameStore.getState();
    if (state.diamondFXInstance) {
      state.diamondFXInstance.update(config);
    }
  }, [config]);

  return <canvas ref={canvasRef} />;
};

AnimatedFrame.displayName = "AnimatedFrame";

// ============================================================================
// DiamondFX Core Implementation
// ============================================================================

function createDiamondFX(
  canvas: HTMLCanvasElement,
  userCfg: DiamondFXConfig = {}
): DiamondFXController {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Could not get 2d context");

  // Clone DEFAULTS manually to avoid structuredClone issues with functions
  const cfg = deepMerge(
    {
      ...DEFAULTS,
      spin: { ...DEFAULTS.spin },
      timings: { ...DEFAULTS.timings },
    },
    userCfg
  ) as InternalDiamondFXConfig;

  let W = 0,
    H = 0,
    DPR = 1;
  let playing = false,
    t0 = 0;
  let currentTargetId: string | null = null;
  let targetRect: Rect | null = null;
  let holdBlink = false,
    blinkLoopStart = 0;
  let rafId: number | null = null;
  let isFadingOut = false,
    fadeOutStart = 0;
  let isAnimatingOut = false,
    animateOutStart = 0;
  let isRefreshing = false,
    refreshStart = 0;
  let refreshFromDockCenters: Point[] | null = null;
  const FADE_OUT_DURATION = 300;

  const fired = {
    start: false,
    in: false,
    morph: false,
    pause: false,
    blink: false,
    spin: false,
    split: false,
    "refresh-start": false,
    "refresh-center": false,
    "refresh-end": false,
    "exit-start": false,
    "exit-out": false,
  };
  let completeFired = false;

  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;
  let parentObserver: MutationObserver | null = null;
  let containerRO: ResizeObserver | null = null;

  // In absolute mode, we translate DOM rects from viewport → canvas space
  let containerLeft = 0;
  let containerTop = 0;

  let parsedStartColor: RGBAColor | null = null;
  let parsedLineColor: RGBAColor | null = null;

  const SAFE_SHADOW_COLOR = "rgba(255,255,255,0.35)";

  const isIdleState = () =>
    !!(
      currentTargetId &&
      !playing &&
      !isFadingOut &&
      !isAnimatingOut &&
      !isRefreshing
    );

  const safeInvoke = <Args extends unknown[]>(
    fn: ((...args: Args) => void) | undefined,
    ...args: Args
  ) => {
    if (!fn) return;
    try {
      fn(...args);
    } catch {
      // Ignore callback errors
    }
  };

  function refreshTargetRect(id: string | null = currentTargetId) {
    if (!id) {
      targetRect = null;
      return targetRect;
    }
    targetRect = getTargetRect(id);
    return targetRect;
  }

  function updateParsedColors() {
    parsedStartColor = cfg.lineStartColor
      ? parseColor(cfg.lineStartColor)
      : null;
    parsedLineColor = parseColor(cfg.lineColor);
  }

  updateParsedColors();

  // Utility functions
  const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const mixPt = (A: Point, B: Point, t: number): Point => ({
    x: lerp(A.x, B.x, t),
    y: lerp(A.y, B.y, t),
  });

  const easeInOutCubic = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const easeOutBack = (t: number) => {
    const c1 = 1.70158,
      c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };

  const easeInOutExpo = (t: number) =>
    t === 0 || t === 1
      ? t
      : t < 0.5
      ? Math.pow(2, 20 * t - 10) / 2
      : (2 - Math.pow(2, -20 * t + 10)) / 2;

  function parseColor(colorStr: string): RGBAColor | null {
    const match = colorStr.match(
      /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
    );
    if (match) {
      return {
        r: parseInt(match[1]),
        g: parseInt(match[2]),
        b: parseInt(match[3]),
        a: match[4] ? parseFloat(match[4]) : 1,
      };
    }
    return null;
  }

  function lerpColor(
    color1: RGBAColor,
    color2: RGBAColor,
    t: number
  ): RGBAColor {
    return {
      r: Math.round(lerp(color1.r, color2.r, t)),
      g: Math.round(lerp(color1.g, color2.g, t)),
      b: Math.round(lerp(color1.b, color2.b, t)),
      a: lerp(color1.a, color2.a, t),
    };
  }

  function colorToString(color: RGBAColor): string {
    return `rgba(${color.r},${color.g},${color.b},${color.a})`;
  }

  function squareCorners(
    cx: number,
    cy: number,
    side: number,
    ang: number
  ): Point[] {
    const h = side / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return [
      { x: cx + (-h * c - -h * s), y: cy + (-h * s + -h * c) },
      { x: cx + (h * c - -h * s), y: cy + (h * s + -h * c) },
      { x: cx + (h * c - h * s), y: cy + (h * s + h * c) },
      { x: cx + (-h * c - h * s), y: cy + (-h * s + h * c) },
    ];
  }

  const lineAngle = (A: Point, B: Point) => Math.atan2(B.y - A.y, B.x - A.x);

  function style(stroke: number, color: string) {
    ctx!.lineWidth = stroke;
    ctx!.strokeStyle = color;
    ctx!.lineCap = "butt";
    ctx!.lineJoin = "miter";
    ctx!.shadowColor = SAFE_SHADOW_COLOR;
    ctx!.shadowBlur = stroke * cfg.shadowBlur;
  }

  function segment(a: Point, b: Point) {
    ctx!.beginPath();
    ctx!.moveTo(a.x, a.y);
    ctx!.lineTo(b.x, b.y);
    ctx!.stroke();
  }

  function polygon(points: Point[]) {
    if (points.length < 2) return;
    ctx!.beginPath();
    ctx!.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx!.lineTo(points[i].x, points[i].y);
    }
    ctx!.closePath();
    ctx!.stroke();
  }

  function dashByCenterAngle(C: Point, halfLen: number, angle: number) {
    const dx = Math.cos(angle) * halfLen;
    const dy = Math.sin(angle) * halfLen;
    segment({ x: C.x - dx, y: C.y - dy }, { x: C.x + dx, y: C.y + dy });
  }

  function totalSpinAngle() {
    if (cfg.spin && typeof cfg.spin.angleDeg === "number")
      return (cfg.spin.angleDeg * Math.PI) / 180;
    return (450 * Math.PI) / 180;
  }

  function getTargetRect(id: string): Rect {
    const el = document.getElementById(id);
    if (!el) {
      // Fallback to canvas center; use canvas dimensions instead of viewport
      return {
        left: W / 2 - 50,
        top: H / 2 - 25,
        right: W / 2 + 50,
        bottom: H / 2 + 25,
        width: 100,
        height: 50,
      };
    }
    const r = el.getBoundingClientRect();
    if (cfg.position === "absolute") {
      // Convert viewport coords to canvas-local coords by subtracting container origin
      return {
        left: r.left - containerLeft,
        top: r.top - containerTop,
        right: r.right - containerLeft,
        bottom: r.bottom - containerTop,
        width: r.width,
        height: r.height,
      };
    }
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  }

  function setupObservers(targetId: string) {
    cleanupObservers();

    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;

    ro = new ResizeObserver(() => {
      if (!currentTargetId) return;
      // Always refresh bounds; only draw when idle/docked
      refreshTargetRect();
      if (isIdleState()) {
        drawDockedTicks();
      }
    });
    ro.observe(targetEl);

    mo = new MutationObserver(() => {
      if (!currentTargetId) return;
      // Always refresh bounds; only draw when idle/docked
      refreshTargetRect();
      if (isIdleState()) {
        drawDockedTicks();
      }
    });
    mo.observe(targetEl, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    parentObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (
            node === targetEl ||
            ((node as Element).contains && (node as Element).contains(targetEl))
          ) {
            if (playing) {
              if (rafId) cancelAnimationFrame(rafId);
              playing = false;
            }
            ctx!.clearRect(0, 0, W, H);
            safeInvoke(cfg.onTargetRemoved, targetId);
            cleanupObservers();
            return;
          }
        }
      }
    });
    parentObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function cleanupObservers() {
    if (ro) {
      ro.disconnect();
      ro = null;
    }
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    if (parentObserver) {
      parentObserver.disconnect();
      parentObserver = null;
    }
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, cfg.maxDPR);

    if (cfg.position === "absolute") {
      const parent = canvas.parentElement || document.body;
      const rect = parent.getBoundingClientRect();
      containerLeft = rect.left;
      containerTop = rect.top;
      W = rect.width;
      H = rect.height;

      canvas.style.position = "absolute";
      canvas.style.top = "0";
      canvas.style.left = "0";
      // inset: 0
      canvas.style.right = "0";
      canvas.style.bottom = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      canvas.style.zIndex = String(cfg.zIndex ?? 10);
      canvas.style.pointerEvents = "none";
    } else {
      containerLeft = 0;
      containerTop = 0;
      W = innerWidth;
      H = innerHeight;

      canvas.style.position = "fixed";
      canvas.style.top = "0";
      canvas.style.left = "0";
      canvas.style.width = "100vw";
      canvas.style.height = "100vh";
      canvas.style.display = "block";
      canvas.style.zIndex = String(cfg.zIndex ?? 10);
      canvas.style.pointerEvents = "none";
    }

    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);

    if (isIdleState()) {
      refreshTargetRect();
      drawDockedTicks();
    }
  }
  addEventListener("resize", resize, { passive: true });
  resize();

  // Observe parent container size changes in absolute mode
  if (!containerRO && canvas.parentElement) {
    containerRO = new ResizeObserver(() => resize());
    try {
      containerRO.observe(canvas.parentElement);
    } catch {
      // ignore
    }
  }

  function getStrokeWidth() {
    return cfg.lineWidthPx ?? Math.max(1.5, Math.min(W, H) * 0.0025);
  }

  function getLineColorWithOpacity(opacity: number) {
    if (opacity >= 1) {
      return cfg.lineColor;
    }
    if (parsedLineColor) {
      return colorToString({
        r: parsedLineColor.r,
        g: parsedLineColor.g,
        b: parsedLineColor.b,
        a: parsedLineColor.a * opacity,
      });
    }
    const match = cfg.lineColor.match(
      /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
    );
    if (match) {
      const [, r, g, b, a] = match;
      const baseAlpha = a ? parseFloat(a) : 1;
      return `rgba(${r},${g},${b},${baseAlpha * opacity})`;
    }
    return cfg.lineColor;
  }

  function drawDockedTicks(opacity = 1) {
    if (!currentTargetId) {
      ctx!.clearRect(0, 0, W, H);
      return;
    }

    const rect = targetRect ?? refreshTargetRect();
    if (!rect) {
      ctx!.clearRect(0, 0, W, H);
      return;
    }
    ctx!.clearRect(0, 0, W, H);

    const stroke = getStrokeWidth();
    style(stroke, getLineColorWithOpacity(opacity));

    const L = cfg.markerLen;
    const half = L / 2;
    const O = cfg.offsetPx;

    const corners = [
      { x: rect.left, y: rect.top },
      { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom },
      { x: rect.left, y: rect.bottom },
    ];

    const outward = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];

    for (let i = 0; i < 4; i++) {
      const C = {
        // Shift horizontally by offset + half so the nearest dash edge is exactly offsetPx
        x: corners[i].x + outward[i].x * (O + half),
        // Vertical spacing remains at offsetPx since dash is horizontal
        y: corners[i].y + outward[i].y * O,
      };
      dashByCenterAngle(C, half, 0);
    }
  }

  function fadeOutLoop(now: number) {
    const elapsed = now - fadeOutStart;
    const progress = Math.min(elapsed / FADE_OUT_DURATION, 1);
    const opacity = 1 - easeInOutCubic(progress);

    drawDockedTicks(opacity);

    if (progress < 1) {
      rafId = requestAnimationFrame(fadeOutLoop);
    } else {
      ctx!.clearRect(0, 0, W, H);
      isFadingOut = false;
      rafId = null;
      currentTargetId = null;
      targetRect = null;
      cleanupObservers();
    }
  }

  // Shared geometry calculations
  function getAnimationContext() {
    const cx = W / 2,
      cy = H / 2;
    const baseAngle = Math.PI / 4;
    const baseSide = Math.min(W, H) * cfg.diamondSize;
    const stroke = getStrokeWidth();

    const screenCorners = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ];

    const dist = Math.hypot(cx, cy);
    const toCenter = [
      { x: cx / dist, y: cy / dist },
      { x: -cx / dist, y: cy / dist },
      { x: -cx / dist, y: -cy / dist },
      { x: cx / dist, y: -cy / dist },
    ];

    const dashHalf = cfg.markerLen / 2;
    const outward = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];

    const rect = targetRect ?? refreshTargetRect() ?? getTargetRect("");
    const elemCorners = [
      { x: rect.left, y: rect.top },
      { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom },
      { x: rect.left, y: rect.bottom },
    ];
    const dockCenters = elemCorners.map((c, i) => ({
      // Match drawDockedTicks so the nearest dash edge is offsetPx from the element
      x: c.x + outward[i].x * (cfg.offsetPx + dashHalf),
      y: c.y + outward[i].y * cfg.offsetPx,
    }));

    return {
      cx,
      cy,
      baseAngle,
      baseSide,
      stroke,
      screenCorners,
      dist,
      toCenter,
      dashHalf,
      outward,
      dockCenters,
    };
  }

  // Phase renderers
  function renderSplitPhase(
    progress: number,
    context: ReturnType<typeof getAnimationContext>,
    dockCentersOverride?: Point[]
  ) {
    const { cx, cy, baseSide, dashHalf, dockCenters } = context;
    const travel = easeInOutCubic(progress);

    const d = squareCorners(cx, cy, baseSide * 1.2, 0);
    const mids = [
      { x: (d[0].x + d[1].x) / 2, y: (d[0].y + d[1].y) / 2 },
      { x: (d[1].x + d[2].x) / 2, y: (d[1].y + d[2].y) / 2 },
      { x: (d[2].x + d[3].x) / 2, y: (d[2].y + d[3].y) / 2 },
      { x: (d[3].x + d[0].x) / 2, y: (d[3].y + d[0].y) / 2 },
    ];

    const useDockCenters = dockCentersOverride ?? dockCenters;
    for (let i = 0; i < 4; i++) {
      dashByCenterAngle(mixPt(mids[i], useDockCenters[i], travel), dashHalf, 0);
    }
  }

  // Variant of split phase that uses a centered square (not edge midpoints)
  // so the dashes contract to a small square rather than a diamond.
  function renderSplitPhaseCenteredSquare(
    progress: number,
    context: ReturnType<typeof getAnimationContext>,
    dockCentersOverride?: Point[]
  ) {
    const { cx, cy, baseSide, dashHalf, dockCenters } = context;
    const travel = easeInOutCubic(progress);

    // Choose a smaller square at the center to converge to/expand from
    const inner = squareCorners(cx, cy, baseSide * 0.7, 0);

    const useDockCenters = dockCentersOverride ?? dockCenters;
    for (let i = 0; i < 4; i++) {
      dashByCenterAngle(
        mixPt(inner[i], useDockCenters[i], travel),
        dashHalf,
        0
      );
    }
  }

  function renderSpinPhase(
    progress: number,
    context: ReturnType<typeof getAnimationContext>
  ) {
    const { cx, cy, baseSide, baseAngle, dashHalf } = context;
    const rotE = easeInOutExpo(progress);
    const shrinkStart = clamp01(cfg.shrinkStart);
    const shrinkRaw = (progress - shrinkStart) / (1 - shrinkStart);
    const shrinkE = clamp01(easeInOutCubic(Math.max(0, shrinkRaw)));
    const totalAngle = totalSpinAngle();
    const angle = (baseAngle + rotE * totalAngle) * (1 - shrinkE);
    const side = baseSide * (1 + 0.2 * rotE);
    const d = squareCorners(cx, cy, side, angle);

    for (let i = 0; i < 4; i++) {
      const A = d[i];
      const B = d[(i + 1) % 4];
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const edgeAng = lineAngle(A, B);
      const edgeHalfLen = Math.hypot(B.x - A.x, B.y - A.y) / 2;
      const halfLen = lerp(edgeHalfLen, dashHalf, shrinkE);
      const theta = edgeAng * (1 - shrinkE);
      dashByCenterAngle(mid, halfLen, theta);
    }
  }

  function renderMorphPhase(
    progress: number,
    context: ReturnType<typeof getAnimationContext>
  ) {
    const { cx, cy, baseSide, baseAngle } = context;
    const m = clamp01(easeInOutCubic(progress));
    const targetCorners = squareCorners(cx, cy, baseSide, baseAngle);

    // Use a unified path: in half mode, grow from center using progress; otherwise draw full size
    const factor = cfg.half ? m : 1;
    const grownCorners = targetCorners.map((pt) =>
      mixPt({ x: cx, y: cy }, pt, factor)
    );
    polygon(grownCorners);
  }

  function renderInPhase(
    progress: number,
    context: ReturnType<typeof getAnimationContext>
  ) {
    const {
      cx,
      cy,
      baseSide,
      baseAngle,
      screenCorners,
      dist,
      toCenter,
      stroke,
    } = context;
    const t = clamp01(progress);
    const fLen = Math.min(1, easeOutBack(t));

    const retractStart = clamp01(cfg.retractStart);
    const retractProgress = clamp01((t - retractStart) / (1 - retractStart));
    const retractAmount = easeInOutCubic(retractProgress);

    const m = clamp01(
      easeInOutCubic(
        (t - clamp01(cfg.morphDuringInStart)) /
          (1 - clamp01(cfg.morphDuringInStart))
      )
    );

    const d = squareCorners(cx, cy, baseSide, baseAngle);
    const edges: [Point, Point][] = [
      [d[0], d[1]],
      [d[1], d[2]],
      [d[2], d[3]],
      [d[3], d[0]],
    ];

    for (let i = 0; i < 4; i++) {
      const c = screenCorners[i];
      const dir = toCenter[i];
      const lineEnd = {
        x: c.x + dir.x * dist * fLen,
        y: c.y + dir.y * fLen * dist,
      };

      const lineStart = mixPt(c, lineEnd, retractAmount);

      const A = mixPt(lineStart, edges[i][0], m);
      const B = mixPt(lineEnd, edges[i][1], m);

      if (parsedStartColor && parsedLineColor) {
        const currentColor = lerpColor(parsedStartColor, parsedLineColor, t);
        const colorStr = colorToString(currentColor);
        style(stroke, colorStr);
      } else {
        style(stroke, cfg.lineColor);
      }

      segment(A, B);
    }
  }

  function animateOutLoop(now: number) {
    const elapsed = now - animateOutStart;

    ctx!.clearRect(0, 0, W, H);
    const context = getAnimationContext();
    style(context.stroke, cfg.lineColor);

    // Reverse animation: split → spin → morph → out
    const splitMs = cfg.timings.split;
    const spinMs = cfg.timings.spin;
    const morphMs = Math.max(0, cfg.timings.morph | 0);
    const outMs = cfg.half ? 0 : cfg.timings.in;

    const tSplit = splitMs;
    const tSpin = tSplit + spinMs;
    const tMorph = tSpin + morphMs;
    const tOut = tMorph + outMs;

    maybeFirePhase(elapsed, [
      { name: "exit-start", end: tMorph, dur: 0 },
      { name: "exit-out", end: tOut, dur: outMs },
    ]);

    // Phase 1: Unsplit (dashes move from docked to diamond center)
    if (elapsed <= tSplit) {
      renderSplitPhase(1 - clamp01(elapsed / splitMs), context); // Reverse progress
      rafId = requestAnimationFrame(animateOutLoop);
      return;
    }

    // Phase 2: Unspin (reverse spin)
    if (elapsed <= tSpin) {
      renderSpinPhase(1 - clamp01((elapsed - tSplit) / spinMs), context); // Reverse progress
      rafId = requestAnimationFrame(animateOutLoop);
      return;
    }

    // Phase 3: Unmorph (diamond to lines)
    if (morphMs > 0 && elapsed <= tMorph) {
      renderMorphPhase(1 - clamp01((elapsed - tSpin) / morphMs), context); // Reverse progress
      rafId = requestAnimationFrame(animateOutLoop);
      return;
    }

    // Phase 4: Out (lines extend to screen corners)
    if (!cfg.half && elapsed <= tOut) {
      renderInPhase(1 - clamp01((elapsed - tMorph) / outMs), context); // Reverse progress
      rafId = requestAnimationFrame(animateOutLoop);
      return;
    }

    // Animation complete
    ctx!.clearRect(0, 0, W, H);
    isAnimatingOut = false;
    rafId = null;
    currentTargetId = null;
    targetRect = null;
    cleanupObservers();

    // Fire onComplete callback with exit=true
    safeInvoke(cfg.onComplete, true);
  }

  // Refresh loop: unsplit (old dock -> center square), split (center square -> new dock)
  function refreshLoop(now: number) {
    const refreshMs = cfg.timings.refresh ?? cfg.timings.split;
    const elapsed = now - refreshStart;

    // Continuously re-measure the current target during refresh
    if (currentTargetId) {
      refreshTargetRect();
    }

    ctx!.clearRect(0, 0, W, H);
    const context = getAnimationContext();
    style(context.stroke, cfg.lineColor);

    const tCenter = refreshMs;
    const tEnd = refreshMs + refreshMs;

    maybeFirePhase(elapsed, [
      { name: "refresh-start", end: 0, dur: 0 },
      { name: "refresh-center", end: tCenter, dur: 0 },
      { name: "refresh-end", end: tEnd, dur: 0 },
    ]);

    if (elapsed <= refreshMs) {
      const p = clamp01(elapsed / refreshMs);
      const rev = 1 - p;
      renderSplitPhaseCenteredSquare(
        rev,
        context,
        refreshFromDockCenters ?? undefined
      );
      rafId = requestAnimationFrame(refreshLoop);
      return;
    }

    if (elapsed <= refreshMs + refreshMs) {
      const p = (elapsed - refreshMs) / refreshMs;
      renderSplitPhaseCenteredSquare(clamp01(p), context);
      rafId = requestAnimationFrame(refreshLoop);
      return;
    }

    drawDockedTicks();
    isRefreshing = false;
    refreshFromDockCenters = null;
    rafId = null;

    safeInvoke(cfg.onComplete, false);
  }

  function maybeFirePhase(elapsed: number, phases: Phase[]) {
    for (const p of phases) {
      if (!fired[p.name as keyof typeof fired] && elapsed >= p.end) {
        fired[p.name as keyof typeof fired] = true;
        safeInvoke(cfg.onPhaseComplete, p.name);
      }
    }
  }

  function draw(now: number) {
    const elapsed = now - t0;

    if (currentTargetId) {
      refreshTargetRect();
    }

    ctx!.clearRect(0, 0, W, H);
    const context = getAnimationContext();
    style(context.stroke, cfg.lineColor);

    const inMs = cfg.half ? 0 : cfg.timings.in;
    const morphMs = Math.max(0, cfg.timings.morph | 0);
    const pauseMs = Math.max(0, cfg.pauseBeforeBlink | 0);
    const blinkMs =
      cfg.blinkDuration !== null
        ? cfg.blinkDuration * cfg.blinkCount
        : cfg.timings.blink;

    const tIn = inMs;
    const tMorph = tIn + morphMs;
    const tPause = tMorph + pauseMs;
    const tBlink = tPause + blinkMs;
    const tSpin = tBlink + cfg.timings.spin;
    const tSplit = tSpin + cfg.timings.split;

    // Fire "start" immediately
    maybeFirePhase(elapsed, [{ name: "start", end: 0, dur: 0 }]);

    if (!cfg.half && elapsed <= tIn) {
      maybeFirePhase(elapsed, [{ name: "in", end: tIn, dur: inMs }]);
      renderInPhase(clamp01(elapsed / tIn), context);
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (morphMs > 0 && elapsed <= tMorph) {
      maybeFirePhase(elapsed, [
        { name: "in", end: tIn, dur: inMs },
        { name: "morph", end: tMorph, dur: morphMs },
      ]);
      const p = (elapsed - (cfg.half ? 0 : tIn)) / morphMs;
      renderMorphPhase(clamp01(p), context);
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (pauseMs > 0 && elapsed <= tPause) {
      maybeFirePhase(elapsed, [
        { name: "in", end: tIn, dur: inMs },
        { name: "morph", end: tMorph, dur: morphMs },
        { name: "pause", end: tPause, dur: pauseMs },
      ]);
      const d = squareCorners(
        context.cx,
        context.cy,
        context.baseSide,
        context.baseAngle
      );
      polygon(d);
      rafId = requestAnimationFrame(draw);
      return;
    }

    const blinkPairs = Math.max(1, cfg.blinkCount * 2);
    const initialFlip = pauseMs === 0 ? 1 : 0;

    if (holdBlink && elapsed >= tPause) {
      // Only fire callbacks up to and including blink when holding
      maybeFirePhase(elapsed, [
        { name: "in", end: tIn, dur: inMs },
        { name: "morph", end: tMorph, dur: morphMs },
        { name: "pause", end: tPause, dur: pauseMs },
        { name: "blink", end: tBlink, dur: blinkMs },
      ]);
      if (!blinkLoopStart) blinkLoopStart = now;
      const loopAge = (now - blinkLoopStart) % blinkMs;
      const blinkT = loopAge / blinkMs;
      const visible = (Math.floor(blinkT * blinkPairs) + initialFlip) % 2 === 0;
      const d = squareCorners(
        context.cx,
        context.cy,
        context.baseSide,
        context.baseAngle
      );
      if (visible) {
        polygon(d);
      }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (elapsed <= tBlink) {
      maybeFirePhase(elapsed, [
        { name: "in", end: tIn, dur: inMs },
        { name: "morph", end: tMorph, dur: morphMs },
        { name: "pause", end: tPause, dur: pauseMs },
        { name: "blink", end: tBlink, dur: blinkMs },
      ]);
      const blinkT = (elapsed - tPause) / blinkMs;
      const visible = (Math.floor(blinkT * blinkPairs) + initialFlip) % 2 === 0;
      const d = squareCorners(
        context.cx,
        context.cy,
        context.baseSide,
        context.baseAngle
      );
      if (visible) {
        polygon(d);
      }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (elapsed <= tSpin) {
      maybeFirePhase(elapsed, [
        { name: "in", end: tIn, dur: inMs },
        { name: "morph", end: tMorph, dur: morphMs },
        { name: "pause", end: tPause, dur: pauseMs },
        { name: "blink", end: tBlink, dur: blinkMs },
        { name: "spin", end: tSpin, dur: cfg.timings.spin },
      ]);
      const spinT = (elapsed - tBlink) / cfg.timings.spin;
      renderSpinPhase(spinT, context);
      rafId = requestAnimationFrame(draw);
      return;
    }

    {
      maybeFirePhase(elapsed, [
        { name: "in", end: tIn, dur: inMs },
        { name: "morph", end: tMorph, dur: morphMs },
        { name: "pause", end: tPause, dur: pauseMs },
        { name: "blink", end: tBlink, dur: blinkMs },
        { name: "spin", end: tSpin, dur: cfg.timings.spin },
        { name: "split", end: tSplit, dur: cfg.timings.split },
      ]);
      const p = clamp01((elapsed - tSpin) / cfg.timings.split);
      renderSplitPhase(p, context);

      if (elapsed < tSplit) {
        rafId = requestAnimationFrame(draw);
        return;
      }

      drawDockedTicks();
      if (!completeFired) {
        safeInvoke(cfg.onComplete, false);
        completeFired = true;
      }
      playing = false;
      return;
    }
  }

  function start(targetId: string, wait = false, refresh = true) {
    if (!targetId) return;

    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;

    if (playing && currentTargetId && currentTargetId !== targetId) {
      const elapsed = performance.now() - t0;

      const inMs = cfg.half ? 0 : cfg.timings.in;
      const morphMs = Math.max(0, cfg.timings.morph | 0);
      const pauseMs = Math.max(0, cfg.pauseBeforeBlink | 0);
      const blinkMs =
        cfg.blinkDuration !== null
          ? cfg.blinkDuration * cfg.blinkCount
          : cfg.timings.blink;
      const tSpin = inMs + morphMs + pauseMs + blinkMs + cfg.timings.spin;

      if (elapsed >= tSpin) {
        // Restart
      } else {
        currentTargetId = targetId;
        refreshTargetRect(targetId);
        setupObservers(targetId);
        return;
      }
    }

    // If currently docked and refresh requested, play refresh loop instead
    const docked = isIdleState();
    if (docked && refresh) {
      // Ensure we have the latest bounds for the CURRENT target before capturing old dock centers
      if (currentTargetId) {
        refreshTargetRect();
      }
      // Capture old dock centers based on the latest bounds
      refreshFromDockCenters = getAnimationContext().dockCenters;

      // If switching targets, update observers and bounds to the NEW target before starting refresh
      if (currentTargetId !== targetId) {
        cleanupObservers();
        currentTargetId = targetId;
        refreshTargetRect(targetId);
        setupObservers(targetId);
      } else if (currentTargetId) {
        // Even when not switching, re-evaluate bounds to reflect any layout changes
        refreshTargetRect();
      }

      // Reset refresh phase flags for each refresh animation
      fired["refresh-start"] = false;
      fired["refresh-center"] = false;
      fired["refresh-end"] = false;

      if (rafId) cancelAnimationFrame(rafId);
      isRefreshing = true;
      refreshStart = performance.now();
      rafId = requestAnimationFrame(refreshLoop);
      return;
    }

    if (playing || isFadingOut || isAnimatingOut || isRefreshing) {
      if (rafId) cancelAnimationFrame(rafId);
      playing = false;
      isFadingOut = false;
      isAnimatingOut = false;
      isRefreshing = false;
      refreshFromDockCenters = null;
    }

    Object.keys(fired).forEach((k) => (fired[k as keyof typeof fired] = false));
    completeFired = false;
    holdBlink = !!wait;
    blinkLoopStart = 0;

    currentTargetId = targetId;
    refreshTargetRect(targetId);
    setupObservers(targetId);

    updateParsedColors();

    playing = true;
    t0 = performance.now();
    rafId = requestAnimationFrame(draw);
  }

  function resume() {
    if (!holdBlink) return;
    holdBlink = false;
    blinkLoopStart = 0;

    const inMs = cfg.half ? 0 : cfg.timings.in;
    const morphMs = Math.max(0, cfg.timings.morph | 0);
    const pauseMs = Math.max(0, cfg.pauseBeforeBlink | 0);
    const blinkMs =
      cfg.blinkDuration !== null
        ? cfg.blinkDuration * cfg.blinkCount
        : cfg.timings.blink;
    const tBlink = inMs + morphMs + pauseMs + blinkMs;

    t0 = performance.now() - tBlink;
    if (!fired.blink) {
      fired.blink = true;
      safeInvoke(cfg.onPhaseComplete, "blink");
    }
    if (!playing) {
      playing = true;
      rafId = requestAnimationFrame(draw);
    }
  }

  function clear(animateOut = false) {
    // If animation is still playing, always just clear immediately regardless of animateOut
    if (playing || isFadingOut || isAnimatingOut || isRefreshing) {
      if (rafId) cancelAnimationFrame(rafId);
      playing = false;
      isFadingOut = false;
      isAnimatingOut = false;
      isRefreshing = false;
      holdBlink = false;
      blinkLoopStart = 0;
      Object.keys(fired).forEach(
        (k) => (fired[k as keyof typeof fired] = false)
      );
      completeFired = false;
      ctx!.clearRect(0, 0, W, H);
      // Clean up target tracking and observers to prevent redraw
      currentTargetId = null;
      targetRect = null;
      cleanupObservers();
      return;
    }

    // Only animate out if we're in the docked state (not playing)
    if (rafId) cancelAnimationFrame(rafId);
    Object.keys(fired).forEach((k) => (fired[k as keyof typeof fired] = false));
    completeFired = false;
    holdBlink = false;
    blinkLoopStart = 0;

    if (animateOut && currentTargetId) {
      isAnimatingOut = true;
      animateOutStart = performance.now();
      rafId = requestAnimationFrame(animateOutLoop);
    } else {
      isFadingOut = true;
      fadeOutStart = performance.now();
      rafId = requestAnimationFrame(fadeOutLoop);
    }
  }

  function update(next: DiamondFXConfig = {}) {
    deepMerge(cfg, next);

    if ("lineStartColor" in next || "lineColor" in next) {
      updateParsedColors();
    }

    if (isIdleState()) {
      refreshTargetRect();
      drawDockedTicks();
    }
  }

  function destroy() {
    if (rafId) cancelAnimationFrame(rafId);
    cleanupObservers();
    removeEventListener("resize", resize);
    if (containerRO) {
      try {
        containerRO.disconnect();
      } catch {
        // ignore
      }
      containerRO = null;
    }
  }

  return {
    start,
    resume,
    update,
    clear,
    destroy,
    get isDocked() {
      return !!(
        currentTargetId &&
        !playing &&
        !isFadingOut &&
        !isAnimatingOut &&
        !isRefreshing
      );
    },
    get isAnimating() {
      return !!(playing || isRefreshing || isFadingOut || isAnimatingOut);
    },
  };
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  src: Partial<T>
): T {
  for (const k in src) {
    const v = src[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k]) target[k] = {} as T[Extract<keyof T, string>];
      deepMerge(
        target[k] as Record<string, unknown>,
        v as Record<string, unknown>
      );
    } else {
      target[k] = v as T[Extract<keyof T, string>];
    }
  }
  return target;
}

// Type definitions
interface Point {
  x: number;
  y: number;
}

interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Phase {
  name: string;
  end: number;
  dur: number;
}
