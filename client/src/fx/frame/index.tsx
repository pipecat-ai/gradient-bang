/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from "react";
import useGameStore from "../../stores/game";

/**
 * Configuration interface for DiamondFX animation
 */
export interface DiamondFXConfig {
  /** Skip corner-to-center phase, start at center (default: false) */
  half?: boolean;
  /** Line/dash color (default: 'rgba(255,255,255,0.95)') */
  lineColor?: string;
  /** Starting color at corners, fades to lineColor (default: null, same as lineColor) */
  lineStartColor?: string | null;
  /** Line width in pixels, null=auto-scale (default: null) */
  lineWidthPx?: number | null;
  /** Diamond size as fraction of viewport (default: 0.07) */
  diamondSize?: number;
  /** Number of blink cycles (default: 3) */
  blinkCount?: number;
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
  };
  /** Callback when animation finishes */
  onComplete?: () => void;
  /** Callback after each phase */
  onPhaseComplete?: (phase: string) => void;
  /** Callback when target element removed from DOM */
  onTargetRemoved?: (targetId: string) => void;
}

/**
 * Performance presets for different device capabilities
 */
export const PERFORMANCE_PRESETS = {
  low: {
    maxDPR: 1.5,
    shadowBlur: 0,
    timings: { in: 400, morph: 120, blink: 200, spin: 700, split: 180 },
  },
  mid: {
    maxDPR: 2.0,
    shadowBlur: 0.5,
    timings: { in: 520, morph: 180, blink: 260, spin: 900, split: 220 },
  },
  high: {
    maxDPR: 2.5,
    shadowBlur: 1.5,
    timings: {
      in: 600,
      morph: 200,
      blink: 300,
      spin: 1000,
      split: 250,
    },
  },
} as const;

/**
 * DiamondFX controller methods
 */
export interface DiamondFXController {
  /** Start animation targeting element by ID */
  start: (targetId: string, wait?: boolean) => void;
  /** Continue from blink phase (when started with wait=true) */
  resume: () => void;
  /** Stop animation if playing, or fade out docked dashes */
  clear: () => void;
  /** Update configuration (applies to next animation) */
  update: (config: DiamondFXConfig) => void;
  /** Clean up all observers and event listeners */
  destroy: () => void;
}

interface AnimatedFrameProps {
  config?: DiamondFXConfig;
}

type InternalDiamondFXConfig = Required<
  Omit<DiamondFXConfig, "lineStartColor" | "lineWidthPx">
> & {
  lineStartColor: string | null;
  lineWidthPx: number | null;
};

const DEFAULTS: InternalDiamondFXConfig = {
  half: false,
  lineColor: "rgba(255,255,255,0.95)",
  lineStartColor: null,
  lineWidthPx: null,
  diamondSize: 0.07,
  blinkCount: 3,
  markerLen: 16,
  offsetPx: 12,
  morphDuringInStart: 0.6,
  retractStart: 0.4,
  pauseBeforeBlink: 0,
  shrinkStart: 0.65,
  shadowBlur: 1.0,
  maxDPR: 2.5,
  spin: { angleDeg: 450 },
  timings: { in: 520, morph: 180, blink: 260, spin: 900, split: 220 },
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const state = useGameStore.getState();

    if (!state.diamondFXInstance) {
      console.log("[DIAMONDFX] Initializing DiamondFX instance");
      const fx = createDiamondFX(canvas, config);
      state.setDiamondFXInstance(fx);
    }

    return () => {
      const state = useGameStore.getState();
      if (state.diamondFXInstance) {
        console.log("[DIAMONDFX] Cleaning up DiamondFX instance");
        state.diamondFXInstance.destroy();
        state.setDiamondFXInstance(undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  let targetRect: DOMRect | null = null;
  let holdBlink = false,
    blinkLoopStart = 0;
  let rafId: number | null = null;
  let isFadingOut = false,
    fadeOutStart = 0;
  const FADE_OUT_DURATION = 300;

  const fired = {
    in: false,
    morph: false,
    pause: false,
    blink: false,
    spin: false,
    split: false,
  };
  let completeFired = false;

  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;
  let parentObserver: MutationObserver | null = null;

  let parsedStartColor: RGBAColor | null = null;
  let parsedLineColor: RGBAColor | null = null;

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
    ctx!.lineCap = "round";
    ctx!.lineJoin = "round";
    ctx!.shadowColor = "rgba(255,255,255,0.35)";
    ctx!.shadowBlur = stroke * cfg.shadowBlur;
  }

  function segment(a: Point, b: Point) {
    ctx!.beginPath();
    ctx!.moveTo(a.x, a.y);
    ctx!.lineTo(b.x, b.y);
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
      const W = innerWidth,
        H = innerHeight;
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
      if (currentTargetId && !playing && !isFadingOut) {
        targetRect = getTargetRect(currentTargetId) as DOMRect;
        drawDockedTicks();
      }
    });
    ro.observe(targetEl);

    mo = new MutationObserver(() => {
      if (currentTargetId && !playing && !isFadingOut) {
        targetRect = getTargetRect(currentTargetId) as DOMRect;
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
            if (typeof cfg.onTargetRemoved === "function") {
              try {
                cfg.onTargetRemoved(targetId);
              } catch {
                // Ignore callback errors
              }
            }
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
    W = innerWidth;
    H = innerHeight;

    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
    canvas.style.display = "block";
    canvas.style.zIndex = "10";
    canvas.style.pointerEvents = "none";

    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);

    if (currentTargetId && !playing && !isFadingOut) {
      targetRect = getTargetRect(currentTargetId) as DOMRect;
      drawDockedTicks();
    }
  }
  addEventListener("resize", resize, { passive: true });
  resize();

  function drawDockedTicks(opacity = 1) {
    if (!currentTargetId) {
      ctx!.clearRect(0, 0, W, H);
      return;
    }

    const rect = getTargetRect(currentTargetId);
    ctx!.clearRect(0, 0, W, H);

    const stroke = cfg.lineWidthPx ?? Math.max(1.5, Math.min(W, H) * 0.0025);
    const baseColor = cfg.lineColor;
    let color = baseColor;

    if (opacity < 1) {
      const match = baseColor.match(
        /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
      );
      if (match) {
        const [, r, g, b] = match;
        color = `rgba(${r},${g},${b},${opacity})`;
      }
    }

    style(stroke, color);

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
        x: corners[i].x + outward[i].x * O,
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
    }
  }

  function maybeFirePhase(elapsed: number, phases: Phase[]) {
    for (const p of phases) {
      if (p.dur <= 0) continue;
      if (!fired[p.name as keyof typeof fired] && elapsed >= p.end) {
        fired[p.name as keyof typeof fired] = true;
        if (typeof cfg.onPhaseComplete === "function") {
          try {
            cfg.onPhaseComplete(p.name);
          } catch {
            // Ignore callback errors
          }
        }
      }
    }
  }

  function draw(now: number) {
    const elapsed = now - t0;

    if (currentTargetId) {
      targetRect = getTargetRect(currentTargetId) as DOMRect;
    }

    ctx!.clearRect(0, 0, W, H);
    const stroke = cfg.lineWidthPx ?? Math.max(1.5, Math.min(W, H) * 0.0025);
    style(stroke, cfg.lineColor);

    const cx = W / 2,
      cy = H / 2;
    const baseAngle = Math.PI / 4;
    const baseSide = Math.min(W, H) * cfg.diamondSize;

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

    const L = cfg.markerLen,
      dashHalf = L / 2,
      O = cfg.offsetPx;
    const outward = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];

    const inMs = cfg.half ? 0 : cfg.timings.in;
    const morphMs = Math.max(0, cfg.timings.morph | 0);
    const pauseMs = Math.max(0, cfg.pauseBeforeBlink | 0);

    const tIn = inMs;
    const tMorph = tIn + morphMs;
    const tPause = tMorph + pauseMs;
    const tBlink = tPause + cfg.timings.blink;
    const tSpin = tBlink + cfg.timings.spin;
    const tSplit = tSpin + cfg.timings.split;

    maybeFirePhase(elapsed, [
      { name: "in", end: tIn, dur: inMs },
      { name: "morph", end: tMorph, dur: morphMs },
      { name: "pause", end: tPause, dur: pauseMs },
      { name: "blink", end: tBlink, dur: cfg.timings.blink },
      { name: "spin", end: tSpin, dur: cfg.timings.spin },
      { name: "split", end: tSplit, dur: cfg.timings.split },
    ]);

    if (!cfg.half && elapsed <= tIn) {
      const t = clamp01(elapsed / tIn);
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
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (morphMs > 0 && elapsed <= tMorph) {
      const p = (elapsed - (cfg.half ? 0 : tIn)) / morphMs;
      const m = clamp01(easeInOutCubic(p));
      const d = squareCorners(cx, cy, baseSide, baseAngle);
      const edges: [Point, Point][] = [
        [d[0], d[1]],
        [d[1], d[2]],
        [d[2], d[3]],
        [d[3], d[0]],
      ];
      if (cfg.half) {
        for (let i = 0; i < 4; i++) {
          segment(
            mixPt({ x: cx, y: cy }, edges[i][0], m),
            mixPt({ x: cx, y: cy }, edges[i][1], m)
          );
        }
      } else {
        for (let i = 0; i < 4; i++) {
          segment(edges[i][0], edges[i][1]);
        }
      }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (pauseMs > 0 && elapsed <= tPause) {
      const d = squareCorners(cx, cy, baseSide, baseAngle);
      segment(d[0], d[1]);
      segment(d[1], d[2]);
      segment(d[2], d[3]);
      segment(d[3], d[0]);
      rafId = requestAnimationFrame(draw);
      return;
    }

    const blinkPairs = Math.max(1, cfg.blinkCount * 2);
    const initialFlip = pauseMs === 0 ? 1 : 0;

    if (holdBlink && elapsed >= tPause) {
      if (!blinkLoopStart) blinkLoopStart = now;
      const loopAge = (now - blinkLoopStart) % cfg.timings.blink;
      const blinkT = loopAge / cfg.timings.blink;
      const visible = (Math.floor(blinkT * blinkPairs) + initialFlip) % 2 === 0;
      const d = squareCorners(cx, cy, baseSide, baseAngle);
      if (visible) {
        segment(d[0], d[1]);
        segment(d[1], d[2]);
        segment(d[2], d[3]);
        segment(d[3], d[0]);
      }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (elapsed <= tBlink) {
      const blinkT = (elapsed - tPause) / cfg.timings.blink;
      const visible = (Math.floor(blinkT * blinkPairs) + initialFlip) % 2 === 0;
      const d = squareCorners(cx, cy, baseSide, baseAngle);
      if (visible) {
        segment(d[0], d[1]);
        segment(d[1], d[2]);
        segment(d[2], d[3]);
        segment(d[3], d[0]);
      }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (elapsed <= tSpin) {
      const spinT = (elapsed - tBlink) / cfg.timings.spin;
      const rotE = easeInOutExpo(spinT);
      const shrinkStart = clamp01(cfg.shrinkStart);
      const shrinkRaw = (spinT - shrinkStart) / (1 - shrinkStart);
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
      rafId = requestAnimationFrame(draw);
      return;
    }

    {
      const p = clamp01((elapsed - tSpin) / cfg.timings.split);
      const travel = easeInOutCubic(p);

      const d = squareCorners(cx, cy, baseSide * 1.2, 0);
      const mids = [
        { x: (d[0].x + d[1].x) / 2, y: (d[0].y + d[1].y) / 2 },
        { x: (d[1].x + d[2].x) / 2, y: (d[1].y + d[2].y) / 2 },
        { x: (d[2].x + d[3].x) / 2, y: (d[2].y + d[3].y) / 2 },
        { x: (d[3].x + d[0].x) / 2, y: (d[3].y + d[0].y) / 2 },
      ];

      const rect = targetRect || getTargetRect(currentTargetId!);
      const elemCorners = [
        { x: rect.left, y: rect.top },
        { x: rect.right, y: rect.top },
        { x: rect.right, y: rect.bottom },
        { x: rect.left, y: rect.bottom },
      ];
      const dockCenters = elemCorners.map((c, i) => ({
        x: c.x + outward[i].x * O,
        y: c.y + outward[i].y * O,
      }));

      for (let i = 0; i < 4; i++) {
        dashByCenterAngle(mixPt(mids[i], dockCenters[i], travel), dashHalf, 0);
      }

      if (elapsed < tSplit) {
        rafId = requestAnimationFrame(draw);
        return;
      }

      drawDockedTicks();
      if (!completeFired) {
        if (typeof cfg.onComplete === "function") {
          try {
            cfg.onComplete();
          } catch {
            // Ignore callback errors
          }
        }
        completeFired = true;
      }
      playing = false;
      return;
    }
  }

  function start(targetId: string, wait = false) {
    if (!targetId) return;

    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;

    if (playing && currentTargetId && currentTargetId !== targetId) {
      const elapsed = performance.now() - t0;

      const inMs = cfg.half ? 0 : cfg.timings.in;
      const morphMs = Math.max(0, cfg.timings.morph | 0);
      const pauseMs = Math.max(0, cfg.pauseBeforeBlink | 0);
      const tSpin =
        inMs + morphMs + pauseMs + cfg.timings.blink + cfg.timings.spin;

      if (elapsed >= tSpin) {
        // Restart
      } else {
        currentTargetId = targetId;
        targetRect = getTargetRect(targetId) as DOMRect;
        setupObservers(targetId);
        return;
      }
    }

    if (playing || isFadingOut) {
      if (rafId) cancelAnimationFrame(rafId);
      playing = false;
      isFadingOut = false;
    }

    Object.keys(fired).forEach((k) => (fired[k as keyof typeof fired] = false));
    completeFired = false;
    holdBlink = !!wait;
    blinkLoopStart = 0;

    currentTargetId = targetId;
    targetRect = getTargetRect(targetId) as DOMRect;
    setupObservers(targetId);

    parsedStartColor = cfg.lineStartColor
      ? parseColor(cfg.lineStartColor)
      : null;
    parsedLineColor = parseColor(cfg.lineColor);

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
    const tBlink = inMs + morphMs + pauseMs + cfg.timings.blink;

    t0 = performance.now() - tBlink;
    if (!fired.blink) {
      fired.blink = true;
      if (typeof cfg.onPhaseComplete === "function") {
        try {
          cfg.onPhaseComplete("blink");
        } catch {
          // Ignore callback errors
        }
      }
    }
    if (!playing) {
      playing = true;
      rafId = requestAnimationFrame(draw);
    }
  }

  function clear() {
    if (playing) {
      if (rafId) cancelAnimationFrame(rafId);
      playing = false;
      holdBlink = false;
      blinkLoopStart = 0;
      Object.keys(fired).forEach(
        (k) => (fired[k as keyof typeof fired] = false)
      );
      completeFired = false;
      ctx!.clearRect(0, 0, W, H);
      return;
    }

    if (rafId) cancelAnimationFrame(rafId);
    Object.keys(fired).forEach((k) => (fired[k as keyof typeof fired] = false));
    completeFired = false;
    holdBlink = false;
    blinkLoopStart = 0;

    isFadingOut = true;
    fadeOutStart = performance.now();
    rafId = requestAnimationFrame(fadeOutLoop);
  }

  function update(next: DiamondFXConfig = {}) {
    deepMerge(cfg, next);

    if ("lineStartColor" in next || "lineColor" in next) {
      parsedStartColor = cfg.lineStartColor
        ? parseColor(cfg.lineStartColor)
        : null;
      parsedLineColor = parseColor(cfg.lineColor);
    }

    if (currentTargetId && !playing && !isFadingOut) {
      targetRect = getTargetRect(currentTargetId) as DOMRect;
      drawDockedTicks();
    }
  }

  function destroy() {
    if (rafId) cancelAnimationFrame(rafId);
    cleanupObservers();
    removeEventListener("resize", resize);
  }

  return { start, resume, update, clear, destroy };
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
