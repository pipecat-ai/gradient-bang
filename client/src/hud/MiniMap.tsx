import type { CameraState, MiniMapRenderConfig } from "@fx/map/MiniMap";
import {
  DEFAULT_MINIMAP_CONFIG,
  getCurrentCameraState,
  renderMiniMapCanvas,
  updateCurrentSector,
} from "@fx/map/MiniMap";
import { useEffect, useMemo, useRef } from "react";

export type MiniMapConfigOverrides = Partial<
  Omit<MiniMapRenderConfig, "current_sector_id" | "colors">
> & {
  colors?: Partial<MiniMapRenderConfig["colors"]>;
};

export const MiniMap = ({
  current_sector_id,
  config,
  map_data,
  width = 440,
  height = 440,
  maxDistance = 3,
  animationDuration = 500,
  showLegend = true,
}: {
  current_sector_id: number;
  config?: MiniMapConfigOverrides;
  map_data: MapData;
  width?: number;
  height?: number;
  maxDistance?: number;
  animationDuration?: number;
  showLegend?: boolean;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStateRef = useRef<CameraState | null>(null);

  const mergedConfig = useMemo<MiniMapRenderConfig>(
    () => ({
      ...DEFAULT_MINIMAP_CONFIG,
      ...config,
      current_sector_id,
      colors: {
        ...DEFAULT_MINIMAP_CONFIG.colors,
        ...config?.colors,
      },
    }),
    [current_sector_id, config]
  );

  const prevSectorIdRef = useRef<number>(current_sector_id);
  const latestPropsRef = useRef({
    width,
    height,
    data: map_data,
    config: mergedConfig,
    maxDistance,
  });

  latestPropsRef.current = {
    width,
    height,
    data: map_data,
    config: mergedConfig,
    maxDistance,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const prevSectorId = prevSectorIdRef.current;
    const props = latestPropsRef.current;

    if (current_sector_id !== prevSectorId && cameraStateRef.current) {
      const cleanup = updateCurrentSector(
        canvas,
        props,
        current_sector_id,
        cameraStateRef.current,
        animationDuration
      );

      setTimeout(() => {
        cameraStateRef.current = getCurrentCameraState(latestPropsRef.current);
      }, animationDuration);

      prevSectorIdRef.current = current_sector_id;
      return cleanup;
    } else {
      renderMiniMapCanvas(canvas, props);
      cameraStateRef.current = getCurrentCameraState(props);
      prevSectorIdRef.current = current_sector_id;
    }
  }, [current_sector_id, animationDuration]);

  return (
    <div style={{ display: "grid", gap: 8, overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        style={{
          width: `${width}px`,
          height: `${height}px`,
          maxWidth: "100%",
          maxHeight: "100%",
          display: "block",
          objectFit: "contain",
        }}
      />
      {showLegend && (
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 12,
            color: "#bbb",
          }}
        >
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                background: mergedConfig.colors.visited,
                border: "1px solid #4caf50",
              }}
            />
            Visited
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                background: mergedConfig.colors.empty,
                border: "1px solid #666",
              }}
            />
            Unvisited
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                background: mergedConfig.colors.port,
                borderRadius: 7,
              }}
            />
            Port
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                background: mergedConfig.colors.mega_port,
                borderRadius: 7,
              }}
            />
            Mega Port
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 16,
                height: 2,
                background: mergedConfig.colors.lane,
              }}
            />
            Lane
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
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
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ position: "relative", width: 18, height: 10 }}>
              <span
                style={{
                  position: "absolute",
                  top: 4,
                  left: 0,
                  width: 12,
                  height: 2,
                  background: mergedConfig.colors.lane_one_way,
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
                  borderLeft: `6px solid ${mergedConfig.colors.lane_one_way}`,
                }}
              />
            </span>
            One-way
          </span>
          {mergedConfig.show_hyperlanes && (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span
                style={{
                  width: 16,
                  height: 2,
                  background: `linear-gradient(90deg, transparent, ${mergedConfig.colors.hyperlane}, transparent)`,
                }}
              />
              Hyperlane
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default MiniMap;
