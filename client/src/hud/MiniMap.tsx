import type { MiniMapConfigBase, MiniMapController } from "@fx/map/MiniMap";
import {
  createMiniMapController,
  DEFAULT_MINIMAP_CONFIG,
} from "@fx/map/MiniMap";
import { useEffect, useMemo, useRef } from "react";

export type MiniMapConfig = Partial<
  Omit<MiniMapConfigBase, "current_sector_id" | "colors">
> & {
  colors?: Partial<MiniMapConfigBase["colors"]>;
};

const mapTopologyChanged = (
  previous: MapData | null,
  next: MapData
): boolean => {
  if (!previous) return true;
  if (previous.length !== next.length) return true;

  const previousHops = new Map<number, number | null>();
  previous.forEach((sector) => {
    previousHops.set(sector.id, sector.hops_from_center ?? null);
  });

  for (const sector of next) {
    if (!previousHops.has(sector.id)) {
      return true;
    }
    const previousHop = previousHops.get(sector.id);
    const nextHop = sector.hops_from_center ?? null;
    if (previousHop !== nextHop) {
      return true;
    }
    previousHops.delete(sector.id);
  }

  return previousHops.size > 0;
};

export const MiniMap = ({
  current_sector_id,
  config,
  map_data,
  width = 440,
  height = 440,
  maxDistance = 2,
  showLegend = true,
}: {
  current_sector_id: number;
  config?: MiniMapConfig;
  map_data: MapData;
  width?: number;
  height?: number;
  maxDistance?: number;
  showLegend?: boolean;
  debug?: boolean;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<MiniMapController | null>(null);
  const prevSectorIdRef = useRef<number>(current_sector_id);
  const previousMapRef = useRef<MapData | null>(null);
  const lastDimensionsRef = useRef<{ width: number; height: number }>({
    width,
    height,
  });
  const lastMaxDistanceRef = useRef<number | undefined>(maxDistance);
  const lastConfigInputRef = useRef<MiniMapConfig | undefined>(config);

  const mergedConfig = useMemo<MiniMapConfigBase>(
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let controller = controllerRef.current;

    if (!controller) {
      controller = createMiniMapController(canvas, {
        width,
        height,
        data: map_data,
        config: mergedConfig,
        maxDistance,
      });
      controllerRef.current = controller;
      prevSectorIdRef.current = current_sector_id;
      previousMapRef.current = map_data;
      lastDimensionsRef.current = { width, height };
      lastMaxDistanceRef.current = maxDistance;
      lastConfigInputRef.current = config;
      return;
    }

    const topologyChanged = mapTopologyChanged(
      previousMapRef.current,
      map_data
    );
    const sectorChanged = current_sector_id !== prevSectorIdRef.current;
    const dimensionsChanged =
      lastDimensionsRef.current.width !== width ||
      lastDimensionsRef.current.height !== height;
    const maxDistanceChanged = lastMaxDistanceRef.current !== maxDistance;
    const configChanged = lastConfigInputRef.current !== config;

    controller.updateProps({
      width,
      height,
      maxDistance,
      config: mergedConfig,
      data: map_data,
    });

    if (sectorChanged || topologyChanged || maxDistanceChanged) {
      controller.moveToSector(current_sector_id, map_data);
      if (sectorChanged) {
        prevSectorIdRef.current = current_sector_id;
      }
    } else if (dimensionsChanged || configChanged) {
      controller.render();
    }

    previousMapRef.current = map_data;
    lastDimensionsRef.current = { width, height };
    lastMaxDistanceRef.current = maxDistance;
    lastConfigInputRef.current = config;
  }, [
    current_sector_id,
    height,
    map_data,
    maxDistance,
    mergedConfig,
    config,
    width,
  ]);

  useEffect(() => {
    return () => {
      controllerRef.current = null;
    };
  }, []);

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
