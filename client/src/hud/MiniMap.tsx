import type { CameraState, MiniMapRenderConfig } from "@fx/map/MiniMap";
import {
  getCurrentCameraState,
  renderMiniMapCanvas,
  updateCurrentSector,
} from "@fx/map/MiniMap";
import { useEffect, useRef } from "react";

export const MiniMap = ({
  config,
  map_data,
  width = 440,
  height = 440,
  maxDistance = 3,
  animationDuration = 500,
}: {
  config: MiniMapRenderConfig;
  map_data: MapData;
  width?: number;
  height?: number;
  maxDistance?: number;
  animationDuration?: number;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStateRef = useRef<CameraState | null>(null);
  const prevSectorIdRef = useRef<number>(config.current_sector_id);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const props = {
      width,
      height,
      data: map_data,
      config,
      maxDistance,
    };

    const currentSectorId = config.current_sector_id;
    const prevSectorId = prevSectorIdRef.current;

    if (currentSectorId !== prevSectorId && cameraStateRef.current) {
      const cleanup = updateCurrentSector(
        canvas,
        props,
        currentSectorId,
        cameraStateRef.current,
        animationDuration
      );

      setTimeout(() => {
        cameraStateRef.current = getCurrentCameraState(props);
      }, animationDuration);

      prevSectorIdRef.current = currentSectorId;
      return cleanup;
    } else {
      renderMiniMapCanvas(canvas, props);
      cameraStateRef.current = getCurrentCameraState(props);
      prevSectorIdRef.current = currentSectorId;
    }
  }, [config, map_data, width, height, maxDistance, animationDuration]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <canvas
        ref={canvasRef}
        style={{ width: `${width}px`, height: `${height}px`, display: "block" }}
      />
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          fontSize: 12,
          color: "#bbb",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 14,
              background: config.colors.visited,
              border: "1px solid #4caf50",
            }}
          />
          Visited
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 14,
              background: config.colors.empty,
              border: "1px solid #666",
            }}
          />
          Unvisited
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 14,
              background: config.colors.port,
              borderRadius: 7,
            }}
          />
          Port
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 14,
              background: config.colors.mega_port,
              borderRadius: 7,
            }}
          />
          Mega Port
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 16,
              height: 2,
              background: config.colors.lane,
            }}
          />
          Lane
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 14,
              border: "2px solid rgba(255,120,120,0.9)",
              background: "transparent",
            }}
          />
          Cross-region sector (vs current)
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ position: "relative", width: 18, height: 10 }}>
            <span
              style={{
                position: "absolute",
                top: 4,
                left: 0,
                width: 12,
                height: 2,
                background: config.colors.lane_one_way,
              }}
            />
            <span
              style={{
                position: "absolute",
                top: 1,
                left: 10,
                width: 0,
                height: 0,
                borderTop: "4px solid transparent",
                borderBottom: "4px solid transparent",
                borderLeft: `6px solid ${config.colors.lane_one_way}`,
              }}
            />
          </span>
          One-way
        </span>
        {config.show_hyperlanes && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 16,
                height: 2,
                background: `linear-gradient(90deg, transparent, ${config.colors.hyperlane}, transparent)`,
              }}
            />
            Hyperlane
          </span>
        )}
      </div>
    </div>
  );
};

export default MiniMap;
