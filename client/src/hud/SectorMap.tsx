/* eslint-disable @typescript-eslint/no-explicit-any */
import cytoscape, { type Core as CytoscapeInstance } from "cytoscape";
// @ts-expect-error - No types available for cytoscape-fcose
import fcose from "cytoscape-fcose";
import React, { useCallback, useEffect, useRef, useState } from "react";

import useGameStore from "@stores/game";

// Register the fcose layout extension
cytoscape.use(fcose);

const MAX_SECTORS = 12;

interface GlobalPosition {
  x: number;
  y: number;
  locked: boolean;
}
const convertSectorsToNodes = (
  sectors: Record<string, Omit<Sector, "id">>,
  centerSector: number,
  maxSectors: number = MAX_SECTORS
): Array<{
  id: number;
  visited: boolean;
  adjacent: number[];
  port_type?: string | null;
}> => {
  const centerKey = centerSector.toString();
  const centerSectorData = sectors[centerKey];

  if (!centerSectorData) {
    return [];
  }
  const visited = new Set<string>();
  const queue: Array<{ sectorId: string; distance: number }> = [
    { sectorId: centerKey, distance: 0 },
  ];
  const result: Array<{
    id: number;
    visited: boolean;
    adjacent: number[];
    port_type?: string | null;
  }> = [];

  const allKnownSectors = new Set<string>();

  while (queue.length > 0 && result.length < maxSectors) {
    const { sectorId, distance } = queue.shift()!;

    if (visited.has(sectorId) || distance > 3) {
      continue;
    }

    visited.add(sectorId);
    const sectorData = sectors[sectorId];

    if (!sectorData) {
      continue;
    }

    const adjacent = sectorData.adjacent_sectors || [];
    adjacent.forEach((adjId) => allKnownSectors.add(adjId.toString()));

    result.push({
      id: Number(sectorId),
      visited: !!sectorData.last_visited,
      adjacent: adjacent,
      port_type: sectorData.port?.code || null,
    });
    if (distance < 3) {
      for (const adjId of adjacent) {
        const adjKey = adjId.toString();
        if (!visited.has(adjKey) && sectors[adjKey]) {
          queue.push({ sectorId: adjKey, distance: distance + 1 });
        }
      }
    }
  }

  for (const sectorId of allKnownSectors) {
    if (
      !visited.has(sectorId) &&
      !sectors[sectorId] &&
      result.length < maxSectors
    ) {
      result.push({
        id: Number(sectorId),
        visited: false,
        adjacent: [],
        port_type: null,
      });
    }
  }

  return result;
};

const applyGlobalPositions = (
  elements: any[]
): {
  elements: any[];
  newPositions: Record<string, { x: number; y: number }>;
} => {
  const newPositions: Record<string, { x: number; y: number }> = {};

  // Don't apply cached positions - let fcose handle all positioning
  // Just track which nodes we have cached positions for
  elements.forEach((element) => {
    if (!element.data.source && !element.data.target) {
      const sectorId = element.data.id;
      const globalPos = globalPositionCache.get(sectorId);

      if (globalPos) {
        newPositions[sectorId] = { x: globalPos.x, y: globalPos.y };
      }
    }
  });

  return { elements, newPositions };
};

const globalPositionCache = new Map<string, GlobalPosition>();

const getDefaultStyles = () => [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "text-valign": "center",
      "text-halign": "center",
      "font-size": "10px",
      color: "#e0e0e0",
      "text-wrap": "wrap",
      "text-max-width": "60px",
      width: "30px",
      height: "30px",
      "background-color": "#b0bec5",
      "border-color": "#1f1f1f",
      "border-width": 1,
    },
  },
  {
    selector: "node.visited",
    style: {
      "background-color": "#81c784",
      color: "#000000",
    },
  },
  {
    selector: "node.visited-leaf",
    style: {
      "background-color": "#a5d6a7",
      color: "#000000",
    },
  },
  {
    selector: "node.unvisited",
    style: {
      "background-color": "#e57373",
      color: "#000000",
    },
  },
  {
    selector: "node.center",
    style: {
      "background-color": "#ffd700",
      color: "#000000",
      "border-color": "#cc9900",
      "border-width": 2,
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.25,
      opacity: 0.85,
      "line-color": "#9aa0a6",
      "target-arrow-shape": "data(targetArrow)",
      "target-arrow-color": "#9aa0a6",
      "arrow-scale": 1.2,
      "curve-style": "straight",
    },
  },
];

const createElements = (nodes: any[], centerId: number) => {
  const elements: any[] = [];

  // Add nodes
  nodes.forEach((node) => {
    const isCenter = node.id === centerId;
    const isLeaf = node.adjacent && node.adjacent.length === 1;
    let classes = "";

    if (isCenter) {
      classes = "center visited";
    } else if (node.visited) {
      if (isLeaf) {
        classes = "visited visited-leaf";
      } else {
        classes = "visited";
      }
    } else {
      classes = "unvisited";
    }

    // Determine label
    let label = `${node.id}`;
    if (node.port_type) {
      label += `\n${node.port_type}`;
    }

    elements.push({
      data: {
        id: node.id.toString(),
        label: label,
        isCenter: isCenter,
      },
      classes: classes,
    });
  });

  // Add edges - only between nodes that exist in our current set
  const nodeIds = new Set(nodes.map((n) => n.id));

  nodes.forEach((node) => {
    node.adjacent.forEach((adjId: number) => {
      // Only create edge if target node exists in our current node set
      if (!nodeIds.has(adjId)) {
        return;
      }

      const edgeId = `${node.id}-${adjId}`;

      // Always create the directional edge (don't skip duplicates)
      // This ensures we show the actual one-way or two-way connections
      elements.push({
        data: {
          id: edgeId,
          source: node.id.toString(),
          target: adjId.toString(),
          targetArrow: "triangle",
        },
      });
    });
  });

  return elements;
};

export const SectorMap: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<CytoscapeInstance | null>(null);
  const sectors = useGameStore((state) => state.getMappedSectors());
  const currentSector = useGameStore.use.sector();
  const moveToSectorAction = useGameStore.use.moveToSectorAction();

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const currentSectorId = currentSector?.id;

  const currentNodes = React.useMemo(() => {
    if (!currentSectorId) {
      return [];
    }
    return convertSectorsToNodes(sectors, currentSectorId, MAX_SECTORS);
  }, [sectors, currentSectorId]);

  const addClickHandler = useCallback(
    (cy: any) => {
      cy.on("tap", "node", (event: any) => {
        const node = event.target;
        const sectorId = parseInt(node.id(), 10);
        console.log(`Clicked on sector ${sectorId}`);
        moveToSectorAction({ id: sectorId }, true);
      });
    },
    [moveToSectorAction]
  );

  const initializeGraph = useCallback(() => {
    if (!containerRef.current || cyRef.current) {
      return;
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: getDefaultStyles() as any,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      autoungrabify: false,
      layout: { name: "preset" },
    });

    addClickHandler(cy);

    if (typeof window !== "undefined") {
      (window as any).cy = cy;
    }

    cyRef.current = cy;
  }, [addClickHandler]);

  const updateGraph = useCallback(
    async (
      nodes: Array<{
        id: number;
        visited: boolean;
        adjacent: number[];
        port_type?: string | null;
      }>,
      centerSector: number
    ) => {
      if (!nodes || nodes.length === 0) {
        if (cyRef.current) {
          cyRef.current.elements().remove();
        }
        return;
      }

      if (!cyRef.current) {
        initializeGraph();
        if (!cyRef.current) return;
      }

      const cy = cyRef.current;
      const elements = createElements(nodes, centerSector);
      const { elements: positionedElements, newPositions } =
        applyGlobalPositions(elements);

      // Get current node IDs in the graph
      const currentNodeIds = new Set(cy.nodes().map((n: any) => n.id()));
      const newNodeIds = new Set(nodes.map((n) => n.id.toString()));

      // Remove nodes that are no longer in the view
      const nodesToRemove = Array.from(currentNodeIds).filter(
        (id) => !newNodeIds.has(id)
      );
      if (nodesToRemove.length > 0) {
        cy.remove(cy.getElementById(nodesToRemove.join(",")));
      }

      // Add/update nodes
      const elementsToAdd = positionedElements.filter((el: any) => {
        if (el.data.source || el.data.target) return true; // Always add edges
        return !currentNodeIds.has(el.data.id); // Only add new nodes
      });

      if (elementsToAdd.length > 0) {
        cy.add(elementsToAdd);
      }

      // Update styling for all nodes (visited status might have changed)
      cy.nodes().forEach((node: any) => {
        const nodeData = nodes.find((n) => n.id.toString() === node.id());
        if (nodeData) {
          node.removeClass("visited unvisited center");
          if (nodeData.id === centerSector) {
            node.addClass("center visited");
          } else if (nodeData.visited) {
            node.addClass("visited");
          } else {
            node.addClass("unvisited");
          }
        }
      });

      // Check if we need layout for new nodes without positions
      const sectorsWithPositions = Object.keys(newPositions).length;
      const totalSectors = nodes.length;
      const needsLayout = sectorsWithPositions < totalSectors;

      if (needsLayout) {
        // Let fcose handle positioning of new nodes while keeping existing ones fixed
        const layout = cy.layout({
          name: "fcose",
          quality: "default",
          randomize: false,
          animate: false,
          fit: false, // Don't auto-fit to avoid moving existing nodes
          nodeDimensionsIncludeLabels: true,
          uniformNodeDimensions: false,
          packComponents: false,
          nodeRepulsion: 8000,
          idealEdgeLength: 100,
          edgeElasticity: 0.45,
          nestingFactor: 0.1,
          gravity: 0.1,
          numIter: 1000,
          // Fix existing nodes in place
          fixedNodeConstraint: cy.nodes().filter((node: any) => {
            const pos = node.position();
            return pos.x !== 0 || pos.y !== 0; // Nodes with real positions stay fixed
          }),
        } as any);

        layout.run();

        // Cache the new positions
        cy.nodes().forEach((node: any) => {
          const sectorId = node.id();
          const position = node.position();
          globalPositionCache.set(sectorId, {
            x: position.x,
            y: position.y,
            locked: true,
          });
        });
      }

      // Center on current sector
      const centerNode = cy.getElementById(centerSector.toString());
      if (centerNode.length > 0) {
        cy.center(centerNode);
      }

      cy.resize();
      setStatus("idle");
    },
    [initializeGraph]
  );

  useEffect(() => {
    if (!currentSectorId) {
      return;
    }

    if (currentNodes.length === 0) {
      setStatus("idle");
      setErrorMessage(null);
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
      return;
    }

    void updateGraph(currentNodes, currentSectorId).catch((error) => {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : String(error));
    });
  }, [currentSectorId, currentNodes, updateGraph]); // sectors dependency is covered by currentNodes

  useEffect(
    () => () => {
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    },
    []
  );

  return (
    <div
      className="w-full h-full relative overflow-hidden rounded-lg bg-black/40 backdrop-blur-sm border border-white/10"
      data-hud-map-root
    >
      <div ref={containerRef} className="hud-map-canvas w-full h-full" />
      <div className="absolute top-2 right-2 text-xs text-white/70 bg-black/60 px-2 py-1 rounded">
        {currentSectorId ? `Sector ${currentSectorId}` : "Sector --"}
      </div>
      {status === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center text-white/70 text-xs bg-black/30">
          Loading local map…
        </div>
      ) : null}
      {status === "error" && errorMessage ? (
        <div className="absolute inset-x-0 bottom-0 m-2 text-amber-200 text-xs bg-amber-800/70 px-2 py-1 rounded">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
};

export default SectorMap;
