import type {
  LabelStyles,
  LaneStyles,
  MiniMapConfigBase,
  MiniMapController,
  NodeStyles,
  PortStyles,
  UIStyles,
} from "@fx/map/MiniMap";
import {
  createMiniMapController,
  DEFAULT_MINIMAP_CONFIG,
} from "@fx/map/MiniMap";
import { deepmerge } from "deepmerge-ts";
import { useEffect, useMemo, useRef, useState } from "react";

export type MiniMapConfig = Partial<
  Omit<
    MiniMapConfigBase,
    | "current_sector_id"
    | "nodeStyles"
    | "laneStyles"
    | "labelStyles"
    | "portStyles"
    | "uiStyles"
  >
> & {
  nodeStyles?: {
    [K in keyof NodeStyles]?: Partial<NodeStyles[K]>;
  };
  laneStyles?: {
    [K in keyof LaneStyles]?: Partial<LaneStyles[K]>;
  };
  labelStyles?: {
    [K in keyof LabelStyles]?: Partial<LabelStyles[K]>;
  };
  portStyles?: {
    [K in keyof PortStyles]?: Partial<PortStyles[K]>;
  };
  uiStyles?: Partial<UIStyles>;
};

const RESIZE_DELAY = 300;

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

const courseplotsEqual = (
  a: CoursePlot | null | undefined,
  b: CoursePlot | null | undefined
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.from_sector === b.from_sector && a.to_sector === b.to_sector;
};

export const MiniMap = ({
  current_sector_id,
  config,
  map_data,
  width,
  height,
  maxDistance = 2,
  showLegend = true,
  coursePlot,
}: {
  current_sector_id: number;
  config?: MiniMapConfig;
  map_data: MapData;
  width?: number;
  height?: number;
  maxDistance?: number;
  showLegend?: boolean;
  debug?: boolean;
  coursePlot?: CoursePlot | null;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<MiniMapController | null>(null);
  const prevSectorIdRef = useRef<number>(current_sector_id);
  const previousMapRef = useRef<MapData | null>(null);
  const lastMaxDistanceRef = useRef<number | undefined>(maxDistance);
  const lastConfigRef = useRef<Omit<
    MiniMapConfigBase,
    "current_sector_id"
  > | null>(null);
  const lastCoursePlotRef = useRef<CoursePlot | null | undefined>(coursePlot);

  const [measuredSize, setMeasuredSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const isAutoSizing = width === undefined && height === undefined;

  // Memoize effective dimensions to prevent unnecessary effect triggers
  const effectiveWidth = useMemo(
    () => width ?? measuredSize?.width ?? 440,
    [width, measuredSize?.width]
  );

  const effectiveHeight = useMemo(
    () => height ?? measuredSize?.height ?? 440,
    [height, measuredSize?.height]
  );

  const lastDimensionsRef = useRef<{ width: number; height: number }>({
    width: effectiveWidth,
    height: effectiveHeight,
  });

  const baseConfig = useMemo<Omit<MiniMapConfigBase, "current_sector_id">>(
    () =>
      deepmerge(DEFAULT_MINIMAP_CONFIG, {
        ...config,
      }) as Omit<MiniMapConfigBase, "current_sector_id">,
    [config]
  );

  // ResizeObserver effect for auto-sizing
  useEffect(() => {
    if (!isAutoSizing || !containerRef.current) return;

    let timeoutId: number | null = null;
    const observer = new ResizeObserver((entries) => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => {
        const entry = entries[0];
        if (entry) {
          const { width, height } = entry.contentRect;
          console.debug("[MAP] Resizing", { width, height });
          setMeasuredSize({ width, height });
        }
      }, RESIZE_DELAY);
    });

    observer.observe(containerRef.current);

    return () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      observer.disconnect();
    };
  }, [isAutoSizing]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return; // Not initialized yet

    const dimensionsChanged =
      lastDimensionsRef.current.width !== effectiveWidth ||
      lastDimensionsRef.current.height !== effectiveHeight;

    if (dimensionsChanged) {
      console.debug("[GAME MINIMAP] Dimensions changed, updating", {
        from: lastDimensionsRef.current,
        to: { width: effectiveWidth, height: effectiveHeight },
      });

      controller.updateProps({
        width: effectiveWidth,
        height: effectiveHeight,
      });
      controller.render();

      lastDimensionsRef.current = {
        width: effectiveWidth,
        height: effectiveHeight,
      };
    }
  }, [effectiveWidth, effectiveHeight]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let controller = controllerRef.current;

    if (!controller) {
      console.debug("[GAME MINIMAP] Initializing MiniMap");

      controller = createMiniMapController(canvas, {
        width: lastDimensionsRef.current.width,
        height: lastDimensionsRef.current.height,
        data: map_data,
        config: { ...baseConfig, current_sector_id },
        maxDistance,
        coursePlot,
      });
      controllerRef.current = controller;
      prevSectorIdRef.current = current_sector_id;
      previousMapRef.current = map_data;
      lastMaxDistanceRef.current = maxDistance;
      lastConfigRef.current = baseConfig;
      lastCoursePlotRef.current = coursePlot;
      return;
    }

    console.debug("[GAME MINIMAP] Updating MiniMap");

    const topologyChanged = mapTopologyChanged(
      previousMapRef.current,
      map_data
    );
    const sectorChanged = current_sector_id !== prevSectorIdRef.current;
    const maxDistanceChanged = lastMaxDistanceRef.current !== maxDistance;
    const configChanged = lastConfigRef.current !== baseConfig;
    const coursePlotChanged = !courseplotsEqual(
      lastCoursePlotRef.current,
      coursePlot
    );
    controller.updateProps({
      maxDistance,
      ...(configChanged && { config: { ...baseConfig, current_sector_id } }),
      data: map_data,
      coursePlot,
    });

    if (
      sectorChanged ||
      topologyChanged ||
      maxDistanceChanged ||
      coursePlotChanged
    ) {
      console.debug("[GAME MINIMAP] Moving to sector", current_sector_id);
      controller.moveToSector(current_sector_id, map_data);
      prevSectorIdRef.current = current_sector_id;
    } else if (configChanged) {
      console.debug("[GAME MINIMAP] Rendering MiniMap");
      controller.render();
    }

    previousMapRef.current = map_data;
    lastMaxDistanceRef.current = maxDistance;
    lastConfigRef.current = baseConfig;
    lastCoursePlotRef.current = coursePlot;
  }, [current_sector_id, map_data, maxDistance, baseConfig, coursePlot]);

  useEffect(() => {
    return () => {
      console.debug("[GAME MINIMAP] Cleaning up MiniMap controller");
      controllerRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gap: 8,
        overflow: "hidden",
        ...(isAutoSizing && { width: "100%", height: "100%" }),
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: `${effectiveWidth}px`,
          height: `${effectiveHeight}px`,
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
                background: baseConfig.nodeStyles.visited.fill,
                border: `${baseConfig.nodeStyles.visited.borderWidth}px solid ${baseConfig.nodeStyles.visited.border}`,
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
                background: baseConfig.nodeStyles.unvisited.fill,
                border: `${baseConfig.nodeStyles.unvisited.borderWidth}px solid ${baseConfig.nodeStyles.unvisited.border}`,
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
                background: baseConfig.portStyles.regular.color,
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
                background: baseConfig.portStyles.mega.color,
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
                background: baseConfig.laneStyles.normal.color,
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
                border: `${baseConfig.nodeStyles.crossRegion.borderWidth}px solid ${baseConfig.nodeStyles.crossRegion.border}`,
                background: baseConfig.nodeStyles.crossRegion.fill,
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
                  background: baseConfig.laneStyles.oneWay.color,
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
                  borderLeft: `6px solid ${baseConfig.laneStyles.oneWay.arrowColor}`,
                }}
              />
            </span>
            One-way
          </span>
          {baseConfig.show_hyperlanes && (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span
                style={{
                  width: 16,
                  height: 2,
                  background: `linear-gradient(90deg, transparent, ${baseConfig.laneStyles.hyperlane.color}, transparent)`,
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
