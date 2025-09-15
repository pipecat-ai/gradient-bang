import React, { useEffect, useRef, useState, useCallback } from 'react';
import GraphLayout from '../utils/GraphLayout';

interface MapVisualizationProps {
  nodeRenderMax?: number;
  minNodeDistance?: number;
  nodeRepulsion?: number;
}

interface Node {
  id: number;
  visited: boolean;
  port_type: string | null;
  adjacent: number[];
}

interface MapData {
  node_list: Node[];
}

export const MapVisualization: React.FC<MapVisualizationProps> = ({
  nodeRenderMax = 25,
  minNodeDistance = 4,
  nodeRepulsion = 16000,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<any>(null); // Changed from cytoscape.Core to any since we're using global GraphLayout
  const [currentSector, setCurrentSector] = useState<number>(0);
  const [sectorHistory, setSectorHistory] = useState<number[]>([0]);
  const [historyIndex, setHistoryIndex] = useState<number>(0);
  const [inputSector, setInputSector] = useState<string>('');
  const [nodeCount, setNodeCount] = useState<number>(0);
  const [metrics, setMetrics] = useState({ crossings: 0, collisions: 0 });
  const [loading, setLoading] = useState(false);
  const [layoutInProgress, setLayoutInProgress] = useState(false);


  // Fetch map data with adaptive hop increase
  const fetchMapData = useCallback(async (sector: number) => {
    setLoading(true);
    try {
      let data: MapData | null = null;
      let prevData: MapData | null = null;
      let prevLength = 0;

      // Start with 1 hop and increase until we get enough nodes
      for (let hops = 1; hops <= 10; hops++) {
        const response = await fetch(`/api/local_map?center=${sector}&max_hops=${hops}&max_nodes=${nodeRenderMax}`);
        if (!response.ok) {
          console.error('Failed to fetch map data:', response.status);
          return null;
        }
        data = await response.json();

        // If we hit the exact max, we might have truncated - use previous result if available
        if (data.node_list.length >= nodeRenderMax) {
          // If this is the first fetch that hit the max, use previous result if it exists
          if (prevData && prevData.node_list.length < nodeRenderMax) {
            return prevData;
          }
          return data;
        }

        // If we have the same number of nodes as last hop, we've found all reachable nodes
        if (data.node_list.length === prevLength) {
          break;
        }

        prevData = data;
        prevLength = data.node_list.length;
      }

      return data;
    } catch (error) {
      console.error('Error fetching map data:', error);
      return null;
    } finally {
      setLoading(false);
    }
  }, [nodeRenderMax]);

  // Render the graph using GraphLayout module
  const renderGraph = useCallback(async (nodes: Node[], centerId: number) => {
    if (!containerRef.current) {
      console.error('Container not ready');
      return;
    }

    // Destroy existing graph
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    setNodeCount(nodes.length);
    setLayoutInProgress(true);

    // Use GraphLayout.render which includes automatic optimization
    const cy = await GraphLayout.render(nodes, centerId, {
      container: containerRef.current,
      minNodeDist: minNodeDistance,
      nodeRepulsion: nodeRepulsion,
      quickMode: false, // Always run full optimization
      autoOptimize: true, // Automatically optimize if there are crossings/collisions
      skipOptRender: true, // Hide during optimization for cleaner UX
      onLayoutComplete: (crossings: number, collisions: number) => {
        setMetrics({ crossings, collisions });
        setLayoutInProgress(false);
      },
      onOptimizeProgress: (attempt: number, maxAttempts: number, crossings: number, collisions: number) => {
        console.log(`Optimization progress: ${attempt}/${maxAttempts} - ${crossings} crossings, ${collisions} collisions`);
        setMetrics({ crossings, collisions });
      }
    });

    cyRef.current = cy;
  }, [minNodeDistance, nodeRepulsion]);

  // Load initial sector
  const loadSector = useCallback(async (sector: number, addToHistory: boolean = true) => {
    const data = await fetchMapData(sector);
    if (data && data.node_list.length > 0) {
      setCurrentSector(sector);

      if (addToHistory) {
        // Add to history if it's a new navigation
        setSectorHistory(prev => {
          const newHistory = [...prev.slice(0, historyIndex + 1), sector];
          setHistoryIndex(newHistory.length - 1);
          return newHistory;
        });
      }

      await renderGraph(data.node_list, sector);
    }
  }, [fetchMapData, renderGraph, historyIndex]);

  // Navigation handlers
  const handlePrevious = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      const sector = sectorHistory[newIndex];
      setCurrentSector(sector);
      loadSector(sector, false);
    }
  };

  const handleNext = () => {
    if (historyIndex < sectorHistory.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      const sector = sectorHistory[newIndex];
      setCurrentSector(sector);
      loadSector(sector, false);
    }
  };

  const handleRandom = () => {
    const newSector = Math.floor(Math.random() * 5000) + 1;
    loadSector(newSector);
  };

  const handleRerunLayout = () => {
    // Re-run layout for current sector without adding to history
    if (currentSector !== null && currentSector !== undefined) {
      loadSector(currentSector, false);
    }
  };

  const handleSectorInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const sector = parseInt(inputSector);
      if (!isNaN(sector) && sector >= 0 && sector < 5000) {
        loadSector(sector);
        setInputSector('');
      }
    }
  };

  // Load initial data
  useEffect(() => {
    loadSector(0, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (cyRef.current) {
        cyRef.current.resize();
        cyRef.current.fit();
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="map-visualization">
      <div className="map-controls">
        <button onClick={handlePrevious} disabled={loading || historyIndex === 0}>
          &lt;&lt; Previous
        </button>
        <span className="sector-info">
          Sector: <strong>{currentSector}</strong> | Nodes: <strong>{nodeCount}</strong>
        </span>
        <input
          type="text"
          className="sector-input"
          placeholder="Sector #"
          value={inputSector}
          onChange={(e) => setInputSector(e.target.value)}
          onKeyDown={handleSectorInput}
          disabled={loading}
        />
        <button onClick={handleRandom} disabled={loading}>
          Map Random Sector
        </button>
        <button onClick={handleNext} disabled={loading || historyIndex === sectorHistory.length - 1}>
          Next &gt;&gt;
        </button>
      </div>

      <div className="map-container" ref={containerRef} style={{ opacity: layoutInProgress ? 0 : 1 }} />

      <div className="map-metrics">
        <span>Edge Crossings: {metrics.crossings}</span>
        <span>Node Collisions: {metrics.collisions}</span>
        <button
          onClick={handleRerunLayout}
          disabled={loading || nodeCount === 0}
          style={{ marginLeft: '20px' }}
        >
          Re-run Layout
        </button>
      </div>

      {(loading || layoutInProgress) && <div className="loading-overlay">Loading...</div>}
    </div>
  );
};