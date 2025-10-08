import type { CSSProperties } from "react";

type CassetteProps = {
  className?: string;
  /** When true, the reel hubs rotate */
  playing?: boolean;
  /** Seconds per full rotation */
  speedSeconds?: number;
  /** Stroke thickness in SVG units (scales with vectorEffect non-scaling-stroke) */
  strokeWidth?: number;
  /** Optional accessible title */
  title?: string;
};

/**
 * Wireframe cassette tape as a scalable SVG.
 * - Single-color via currentColor; pass className to control color.
 * - Reels animate (rotate) when `playing` is true.
 * - Sizes to its container (width/height 100%).
 */
export default function Cassette({
  className,
  playing = false,
  speedSeconds = 3,
  strokeWidth = 2,
  title = "Cassette tape",
}: CassetteProps) {
  const reelStyle: CSSProperties = playing
    ? {
        animation: `cassette-reel-rotate ${speedSeconds}s linear infinite`,
        transformOrigin: "50% 50%",
        transformBox: "fill-box",
      }
    : { transformOrigin: "50% 50%", transformBox: "fill-box" };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 480 270"
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      className={className}
      role="img"
      aria-label={title}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    >
      <style>
        {`
          @keyframes cassette-reel-rotate { to { transform: rotate(360deg); } }
        `}
      </style>

      {/* Outer shell */}
      <rect x="10" y="10" width="460" height="250" rx="22" ry="22" />
      {/* Inner lip */}
      <rect x="20" y="20" width="440" height="230" rx="18" ry="18" />

      {/* Top window */}
      <rect x="40" y="40" width="400" height="110" rx="10" ry="10" />

      {/* Bottom faceplate with screws */}
      <path d="M70 200 h340 a10 10 0 0 1 10 10 v30 H60 v-30 a10 10 0 0 1 10 -10 z" />
      <circle cx="95" cy="230" r="6" />
      <circle cx="385" cy="230" r="6" />

      {/* Capstans / rollers */}
      <circle cx="70" cy="200" r="8" />
      <circle cx="410" cy="200" r="8" />

      {/* Tape path (trapezoid over playheads) */}
      <path d="M70 200 L150 120 M410 200 L330 120" strokeOpacity="0.5" />
      <path d="M150 120 L330 120" strokeOpacity="0.5" />

      {/* Reels */}
      <g transform="translate(160 120)">
        {/* Outer reel ring */}
        <circle cx="0" cy="0" r="48" />
        {/* Rotating hub/spokes */}
        <g style={reelStyle}>
          {/* Semi-transparent thicker border around hub */}
          <circle
            cx="0"
            cy="0"
            r="28"
            strokeOpacity="0.5"
            strokeWidth={strokeWidth * 2.4}
          />
          {/* Hub */}
          <circle cx="0" cy="0" r="22" strokeWidth={strokeWidth * 1.6} />
          {/* Spokes that do not reach exact center */}
          {Array.from({ length: 6 }).map((_, i) => {
            const angle = (i * Math.PI) / 3;
            const inner = 6; // leave a small gap at center
            const outer = 22;
            const x1 = Math.cos(angle) * inner;
            const y1 = Math.sin(angle) * inner;
            const x2 = Math.cos(angle) * outer;
            const y2 = Math.sin(angle) * outer;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </g>
      </g>

      <g transform="translate(320 120)">
        <circle cx="0" cy="0" r="48" />
        <g style={reelStyle}>
          <circle
            cx="0"
            cy="0"
            r="28"
            strokeOpacity="0.5"
            strokeWidth={strokeWidth * 2.4}
          />
          <circle cx="0" cy="0" r="22" strokeWidth={strokeWidth * 1.6} />
          {Array.from({ length: 6 }).map((_, i) => {
            const angle = (i * Math.PI) / 3;
            const inner = 6;
            const outer = 22;
            const x1 = Math.cos(angle) * inner;
            const y1 = Math.sin(angle) * inner;
            const x2 = Math.cos(angle) * outer;
            const y2 = Math.sin(angle) * outer;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </g>
      </g>

      {/* Secondary details at 50% opacity */}
      <g strokeOpacity="0.5">
        {/* Corner screws */}
        <circle cx="40" cy="40" r="6" />
        <circle cx="440" cy="40" r="6" />
        <circle cx="40" cy="230" r="6" />
        <circle cx="440" cy="230" r="6" />

        {/* Center screw */}
        <circle cx="240" cy="210" r="5" />

        {/* Window inner inset */}
        <rect x="50" y="50" width="380" height="90" rx="8" ry="8" />

        {/* Window tick marks along bottom */}
        {Array.from({ length: 13 }).map((_, i) => {
          const x = 70 + i * 28;
          return <line key={`tick-${i}`} x1={x} y1={130} x2={x} y2={140} />;
        })}

        {/* Bottom face ribs */}
        {Array.from({ length: 12 }).map((_, i) => {
          const x = 85 + i * 26;
          return <line key={`rib-${i}`} x1={x} y1={212} x2={x} y2={238} />;
        })}

        {/* Write-protect notches */}
        <rect x="24" y="24" width="22" height="14" rx="2" ry="2" />
        <rect x="434" y="24" width="22" height="14" rx="2" ry="2" />

        {/* Head block and guides */}
        <rect x="220" y="165" width="40" height="12" rx="2" ry="2" />
        <circle cx="205" cy="171" r="3" />
        <circle cx="275" cy="171" r="3" />
        {/* Capstan pair */}
        <circle cx="230" cy="178" r="2.5" />
        <circle cx="260" cy="178" r="2.5" />

        {/* Reel pack rings */}
        <circle cx="160" cy="120" r="60" />
        <circle cx="320" cy="120" r="60" />

        {/* Chamfer hints */}
        <path d="M32 28 L20 40" />
        <path d="M448 28 L460 40" />
        <path d="M32 242 L20 230" />
        <path d="M448 242 L460 230" />
      </g>

      {/* Label area markers */}
      <rect x="200" y="210" width="80" height="22" rx="4" ry="4" />
      <rect x="260" y="210" width="80" height="22" rx="4" ry="4" />
      <rect x="140" y="210" width="40" height="22" rx="4" ry="4" />
    </svg>
  );
}
