/**
 * Graph Layout Module
 *
 * Provides graph layout functionality using Cytoscape.js with fcose algorithm.
 * ES6 module for use in React/TypeScript applications.
 */

import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';

// Register the fcose layout
cytoscape.use(fcose);

// Type definitions
interface Node {
  id: number;
  visited: boolean;
  port_type: string | null;
  adjacent: number[];
}

interface LayoutOptions {
  container?: HTMLElement;
  verbose?: boolean;
  minNodeDist?: number;
  nodeRepulsion?: number;
  maxOptimizeAttempts?: number;
  quickMode?: boolean;
  autoOptimize?: boolean;
  skipOptRender?: boolean;
  skipRender?: boolean;
  maxAttempts?: number;
  onLayoutComplete?: (crossings: number, collisions: number) => void;
  onOptimizeProgress?: (attempt: number, maxAttempts: number, crossings: number, collisions: number) => void;
  onProgress?: (attempt: number, maxAttempts: number, crossings: number, collisions: number) => void;
}

interface LayoutResult {
  crossings: number;
  collisions: number;
  positions?: any;
}

// Start of module implementation

  /**
   * Convert node list to edge pairs for Cytoscape
   */
  function toPairs(nodes) {
    const idToNode = new Map();
    for (const n of nodes) {
      idToNode.set(n.id, n);
    }
    const map = new Map();
    for (const n of nodes) {
      for (const t of n.adjacent || []) {
        if (!idToNode.has(t)) continue;
        const a = Math.min(n.id, t), b = Math.max(n.id, t);
        const key = a + '-' + b;
        const rec = map.get(key) || { a, b, hasAB: false, hasBA: false };
        if (n.id === a) rec.hasAB = true; else rec.hasBA = true;
        map.set(key, rec);
      }
    }
    return Array.from(map.values());
  }

  /**
   * Count edge crossings in the graph
   */
  function countCrossings(cyInstance, debug = false) {
    let crossings = 0;
    const edges = cyInstance.edges();

    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const e1 = edges[i];
        const e2 = edges[j];

        const e1Src = e1.source().id();
        const e1Tgt = e1.target().id();
        const e2Src = e2.source().id();
        const e2Tgt = e2.target().id();

        // Skip if edges share a node
        if (e1Src === e2Src || e1Src === e2Tgt ||
            e1Tgt === e2Src || e1Tgt === e2Tgt) {
          continue;
        }

        // Check if edges intersect
        const p1 = e1.source().position();
        const p2 = e1.target().position();
        const p3 = e2.source().position();
        const p4 = e2.target().position();

        // Line segment intersection test with numerical precision handling
        const ccw = (A, B, C) => {
          const val = (C.y - A.y) * (B.x - A.x) - (B.y - A.y) * (C.x - A.x);
          // Use a small epsilon for numerical stability
          const epsilon = 1e-10;
          return Math.abs(val) < epsilon ? false : val > 0;
        };

        const ccw1 = ccw(p1, p3, p4);
        const ccw2 = ccw(p2, p3, p4);
        const ccw3 = ccw(p1, p2, p3);
        const ccw4 = ccw(p1, p2, p4);

        if (ccw1 !== ccw2 && ccw3 !== ccw4) {
          crossings++;
          if (debug) {
            console.log(`Crossing detected: ${e1Src}-${e1Tgt} × ${e2Src}-${e2Tgt}`);
          }
        }
      }
    }

    return crossings;
  }

  /**
   * Count node/edge collisions in the graph
   */
  function countNodeEdgeCollisions(cyInstance, options = {}) {
    const minDist = options.minNodeDist || 4;
    const nodeRadius = options.nodeRadius || 20;
    const verbose = options.verbose || false;

    let collisions = 0;
    const collisionDetails = [];

    cyInstance.edges().forEach(edge => {
      const src = edge.source();
      const tgt = edge.target();
      const srcPos = src.position();
      const tgtPos = tgt.position();

      cyInstance.nodes().forEach(node => {
        if (node.id() !== src.id() && node.id() !== tgt.id()) {
          const nodePos = node.position();

          // Calculate distance from point to line segment
          const A = nodePos.x - srcPos.x;
          const B = nodePos.y - srcPos.y;
          const C = tgtPos.x - srcPos.x;
          const D = tgtPos.y - srcPos.y;

          const dot = A * C + B * D;
          const lenSq = C * C + D * D;

          if (lenSq === 0) return; // Edge has zero length

          let param = dot / lenSq;

          // Only consider the middle portion of the edge (not near endpoints)
          if (param > 0.1 && param < 0.9) {
            // Point on the edge closest to the node
            const xx = srcPos.x + param * C;
            const yy = srcPos.y + param * D;

            const dx = nodePos.x - xx;
            const dy = nodePos.y - yy;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // If edge passes through or very close to node
            if (distance < nodeRadius + minDist) {
              collisions++;
              if (verbose) {
                collisionDetails.push({
                  node: node.id(),
                  edge: `${src.id()}-${tgt.id()}`,
                  distance: distance.toFixed(1)
                });
              }
            }
          }
        }
      });
    });

    if (verbose && collisionDetails.length > 0) {
      console.log(`Collision details (${collisionDetails.length} total):`);
      const byNode = {};
      collisionDetails.forEach(detail => {
        if (!byNode[detail.node]) {
          byNode[detail.node] = [];
        }
        byNode[detail.node].push(detail.edge);
      });

      Object.entries(byNode).forEach(([node, edges]) => {
        console.log(`  Node ${node} collides with edges: ${edges.join(', ')}`);
      });
    }

    return collisions;
  }

  /**
   * Create Cytoscape elements from node list
   */
  function createElements(nodes, centerId) {
    const elements = [];

    // Add nodes
    for (const n of nodes) {
      const label = n.port_type ? `${n.id}\n${n.port_type}` : String(n.id);

      elements.push({
        data: {
          id: String(n.id),
          label: label,
          visited: n.visited,
          port_type: n.port_type,
          isCenter: n.id === centerId
        },
        classes: n.id === centerId ? 'center' : (n.visited ? 'visited' : 'unvisited')
      });
    }

    // Add edges
    const pairs = toPairs(nodes);
    for (const e of pairs) {
      const edgeId = `${e.a}-${e.b}`;
      let targetArrow = 'none';
      let sourceArrow = 'none';

      if (e.hasAB && e.hasBA) {
        // Bidirectional
        targetArrow = 'triangle';
        sourceArrow = 'triangle';
      } else if (e.hasAB) {
        // A -> B
        targetArrow = 'triangle';
      } else if (e.hasBA) {
        // B -> A
        sourceArrow = 'triangle';
      }

      elements.push({
        data: {
          id: edgeId,
          source: String(e.a),
          target: String(e.b),
          targetArrow: targetArrow,
          sourceArrow: sourceArrow
        }
      });
    }

    return elements;
  }

  /**
   * Get default layout options for fcose
   */
  function getLayoutOptions(options = {}) {
    const minNodeDist = options.minNodeDist || 4;
    const nodeRepulsion = options.nodeRepulsion || 16000;
    const quickMode = options.quickMode || false;

    return {
      name: 'fcose',
      animate: false,
      fit: true,
      padding: 30,
      randomize: true,
      quality: 'proof',
      nodeDimensionsIncludeLabels: true,
      idealEdgeLength: edge => {
        const src = edge.source();
        const tgt = edge.target();
        const srcDegree = src.degree();
        const tgtDegree = tgt.degree();
        const avgDegree = (srcDegree + tgtDegree) / 2;
        return Math.max(minNodeDist * 2, Math.min(minNodeDist * 8, 80 + avgDegree * 10));
      },
      nodeRepulsion: node => nodeRepulsion * 2.0,
      nodeOverlap: minNodeDist + 15,
      numIter: quickMode ? 5000 : 15000,
      tile: false,
      tilingPaddingVertical: 20,
      tilingPaddingHorizontal: 20,
      gravity: 0.05,
      gravityRange: 10.0,
      initialEnergyOnIncremental: 0.05,
      edgeElasticity: edge => 0.2,
      nestingFactor: 0.1,
      nodeSeparation: minNodeDist * 2,
      uniformNodeDimensions: false,
      packComponents: false,
      step: 'all',
      sampleSize: 500,
      minTemp: 0.01,
      initialTemp: 500,
      coolingFactor: 0.995,
      componentSpacing: 150,
      nodeRepulsionUniformity: 0.3,
      improveFlow: true,
      randomizationSeed: Math.floor(Math.random() * 1000)
    };
  }

  /**
   * Run a complete layout pass with optimization
   * This creates a Cytoscape instance, runs layout, and optimizes if needed
   * Returns metrics and positions after all optimization attempts
   */
  async function runLayout(nodes, centerId, options = {}) {
    const verbose = options.verbose || false;
    const minNodeDist = options.minNodeDist || 4;
    const nodeRepulsion = options.nodeRepulsion || 16000;
    const maxOptimizeAttempts = options.maxOptimizeAttempts || 20;
    const enhancedOptimization = options.enhancedOptimization !== false;

    // Create elements
    const elements = createElements(nodes, centerId);

    // Create headless Cytoscape instance
    const cy = cytoscape({
      headless: true,
      elements: elements
    });

    // Configure and run initial fcose layout
    const layoutOptions = getLayoutOptions({
      minNodeDist,
      nodeRepulsion,
      quickMode: false
    });

    const layout = cy.layout(layoutOptions);

    // Run layout and wait for completion
    await new Promise((resolve) => {
      layout.on('layoutstop', resolve);
      layout.run();
    });

    // Count initial metrics
    const initialCrossings = countCrossings(cy);
    const initialCollisions = countNodeEdgeCollisions(cy, { minNodeDist });

    // If we have problems, run optimization
    if (initialCrossings > 0 || initialCollisions > 0) {
      if (verbose) {
        console.log(`  Initial: ${initialCrossings} crossings, ${initialCollisions} collisions`);
        console.log(`  Running optimization...`);
      }

      let bestCrossings = initialCrossings;
      let bestCollisions = initialCollisions;
      let bestPositions = {};

      // Save current positions as best so far
      cy.nodes().forEach(node => {
        bestPositions[node.id()] = node.position();
      });

      // Use enhanced optimization for problematic sectors
      let actualMaxAttempts = maxOptimizeAttempts;
      if (enhancedOptimization && (initialCollisions > 2 || initialCrossings > 1)) {
        actualMaxAttempts = Math.max(maxOptimizeAttempts, 30);
        if (verbose) {
          console.log(`  Using enhanced optimization with ${actualMaxAttempts} attempts`);
        }
      }

      for (let attempt = 0; attempt < actualMaxAttempts; attempt++) {
        // Vary parameters progressively for better exploration
        const repulsionMultiplier = 2.0 + (attempt % 5) * 0.5; // Vary from 2.0 to 4.0
        const iterCount = 10000 + (attempt % 3) * 5000; // Vary from 10000 to 20000
        const gravityValue = 0.05 + (attempt % 4) * 0.02; // Vary from 0.05 to 0.11

        // Run layout again with new random seed and varied parameters
        const optLayout = cy.layout({
          name: 'fcose',
          animate: false,
          randomize: true,
          quality: 'proof',
          numIter: iterCount,
          randomizationSeed: Math.floor(Math.random() * 10000),
          idealEdgeLength: edge => {
            const avgDegree = (edge.source().degree() + edge.target().degree()) / 2;
            // Adjust edge length based on attempt for variety
            const lengthMultiplier = 1.0 + (attempt % 2) * 0.2;
            return Math.max(minNodeDist * 2, Math.min(minNodeDist * 8, (80 + avgDegree * 10) * lengthMultiplier));
          },
          nodeRepulsion: node => nodeRepulsion * repulsionMultiplier,
          nodeOverlap: minNodeDist + 15 + (attempt % 3) * 5,
          gravity: gravityValue,
          gravityRange: 10.0,
          edgeElasticity: edge => 0.2,
          sampleSize: 500,
          minTemp: 0.01,
          initialTemp: 500 + (attempt % 3) * 200,
          coolingFactor: 0.995,
          improveFlow: true
        });

        await new Promise((resolve) => {
          optLayout.on('layoutstop', resolve);
          optLayout.run();
        });

        const newCrossings = countCrossings(cy);
        const newCollisions = countNodeEdgeCollisions(cy, { minNodeDist });

        if (newCrossings < bestCrossings ||
            (newCrossings === bestCrossings && newCollisions < bestCollisions)) {
          bestCrossings = newCrossings;
          bestCollisions = newCollisions;
          cy.nodes().forEach(node => {
            bestPositions[node.id()] = node.position();
          });

          if (verbose) {
            console.log(`  Attempt ${attempt + 1}: Improved to ${bestCrossings} crossings, ${bestCollisions} collisions`);
          }
        }

        // Stop if perfect
        if (bestCrossings === 0 && bestCollisions === 0) {
          if (verbose) {
            console.log(`  Success! Found perfect layout at attempt ${attempt + 1}`);
          }
          break;
        }
      }

      // Restore best positions
      cy.nodes().forEach(node => {
        node.position(bestPositions[node.id()]);
      });

      // Get final positions for return
      const positions = {};
      cy.nodes().forEach(node => {
        positions[node.id()] = node.position();
      });

      return {
        crossings: bestCrossings,
        collisions: bestCollisions,
        positions: positions
      };
    }

    // Get positions for return
    const positions = {};
    cy.nodes().forEach(node => {
      positions[node.id()] = node.position();
    });

    return {
      crossings: initialCrossings,
      collisions: initialCollisions,
      positions: positions
    };
  }

  /**
   * Optimize layout to minimize crossings and collisions
   */
  async function optimizeLayout(cy, options = {}) {
    const maxAttempts = options.maxAttempts || 12;
    const minNodeDist = options.minNodeDist || 4;
    const nodeRepulsion = options.nodeRepulsion || 16000;
    const skipRender = options.skipRender !== false;
    const onProgress = options.onProgress || (() => {});
    const quiet = options.quiet || false; // Add quiet mode option
    const enhancedOptimization = options.enhancedOptimization !== false;

    let bestPositions = {};
    cy.nodes().forEach(node => {
      bestPositions[node.id()] = node.position();
    });

    let bestCrossings = countCrossings(cy);
    let bestCollisions = countNodeEdgeCollisions(cy, { minNodeDist });
    let bestScore = bestCrossings + bestCollisions;

    if (!quiet) {
      console.log(`Starting optimization: ${bestCrossings} crossings, ${bestCollisions} collisions`);
    }

    // Use enhanced optimization if initial results are problematic
    let actualMaxAttempts = maxAttempts;
    if (enhancedOptimization && (bestCollisions > 2 || bestCrossings > 1)) {
      actualMaxAttempts = Math.max(maxAttempts, 25);
      if (!quiet) {
        console.log(`Using enhanced optimization with ${actualMaxAttempts} attempts`);
      }
    }

    for (let attempt = 0; attempt < actualMaxAttempts; attempt++) {
      if (!quiet) {
        console.log(`Starting optimization attempt ${attempt + 1} of ${actualMaxAttempts}...`);
      }

      // Add small delay between attempts
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Vary parameters for better exploration
      const quickMode = attempt < actualMaxAttempts / 2; // Use quick mode for first half
      const repulsionMultiplier = 1.0 + (attempt / actualMaxAttempts); // Gradually increase repulsion

      // Run layout with new random seed and varied parameters
      const layoutOptions = getLayoutOptions({
        minNodeDist,
        nodeRepulsion: nodeRepulsion * repulsionMultiplier,
        quickMode
      });
      layoutOptions.randomizationSeed = Math.floor(Math.random() * 10000);

      // Vary additional parameters
      if (attempt % 3 === 0) {
        layoutOptions.gravity = 0.1;
        layoutOptions.coolingFactor = 0.99;
      }
      if (attempt % 4 === 0) {
        layoutOptions.initialTemp = 800;
      }

      const layout = cy.layout(layoutOptions);

      await new Promise((resolve) => {
        layout.on('layoutstop', () => {
          resolve();
        });
        layout.run();
      });

      // Check results
      const crossings = countCrossings(cy);
      const collisions = countNodeEdgeCollisions(cy, { minNodeDist });
      const score = crossings + collisions;

      if (!quiet) {
        console.log(`  Attempt ${attempt + 1}: ${crossings} crossings, ${collisions} collisions`);
      }

      // Update best if improved
      if (score < bestScore ||
          (score === bestScore && crossings < bestCrossings)) {
        bestScore = score;
        bestCrossings = crossings;
        bestCollisions = collisions;
        cy.nodes().forEach(node => {
          bestPositions[node.id()] = node.position();
        });
        if (!quiet) {
          console.log(`  Improved! New best: ${bestCrossings} crossings, ${bestCollisions} collisions`);
        }
      }

      onProgress(attempt + 1, maxAttempts, bestCrossings, bestCollisions);

      // Stop if perfect
      if (bestScore === 0) {
        if (!quiet) {
          console.log(`Perfect layout found after ${attempt + 1} attempts!`);
        }
        break;
      }
    }

    // Restore best positions
    cy.nodes().forEach(node => {
      node.position(bestPositions[node.id()]);
    });

    if (!quiet) {
      console.log(`Optimization complete: ${bestCrossings} crossings, ${bestCollisions} collisions`);
    }

    return {
      crossings: bestCrossings,
      collisions: bestCollisions,
      positions: bestPositions
    };
  }

  /**
   * Main render function for graph layout
   */
  async function render(nodes, centerId, options = {}) {
    const container = options.container;
    const minNodeDist = options.minNodeDist || 4;
    const nodeRepulsion = options.nodeRepulsion || 16000;
    const quickMode = options.quickMode || false;
    const autoOptimize = options.autoOptimize !== false;
    const skipOptRender = options.skipOptRender !== false;
    const styles = options.styles || getDefaultStyles();
    const onLayoutComplete = options.onLayoutComplete || (() => {});

    // Only log in non-headless mode
    if (container) {
      console.log(`Render called with ${nodes.length} nodes, center: ${centerId}, quickMode: ${quickMode}`);
    }

    // Create elements
    const elements = createElements(nodes, centerId);

    // Initialize Cytoscape (headless if no container)
    const cyConfig = {
      elements: elements,
      autoungrabify: false,
      autounselectify: false,
      boxSelectionEnabled: false,
      minZoom: 0.5,
      maxZoom: 3,
      style: styles
    };

    if (container) {
      cyConfig.container = container;

      // If skipOptRender is true, hide the container initially
      if (skipOptRender && !quickMode && autoOptimize) {
        container.style.visibility = 'hidden';
      }
    } else {
      cyConfig.headless = true;
    }

    const cy = cytoscape(cyConfig);

    // Run initial layout
    const layoutOptions = getLayoutOptions({ minNodeDist, nodeRepulsion, quickMode });
    const layout = cy.layout(layoutOptions);

    if (container) {
      console.log('Starting layout...');
    }

    await new Promise((resolve) => {
      layout.on('layoutstop', async () => {
        if (container) {
          console.log(`Layout stopped. quickMode: ${quickMode}`);
        }

        // Only auto-optimize if not in quickMode
        if (!quickMode && autoOptimize) {
          const crossings = countCrossings(cy);
          const collisions = countNodeEdgeCollisions(cy, { minNodeDist });
          if (container) {
            console.log(`Initial layout complete: ${crossings} edge crossings, ${collisions} node/edge collisions`);
          }

          if (crossings > 0 || collisions > 0) {
            if (container) {
              console.log('Auto-running optimization due to crossings/collisions...');
            }
            const result = await optimizeLayout(cy, {
              minNodeDist,
              nodeRepulsion,
              skipRender: skipOptRender,
              onProgress: options.onOptimizeProgress,
              enhancedOptimization: true
            });

            // Show the container now that optimization is complete
            if (container && skipOptRender) {
              container.style.visibility = 'visible';
            }

            onLayoutComplete(result.crossings, result.collisions);
          } else {
            // Show the container if we skipped optimization
            if (container && skipOptRender) {
              container.style.visibility = 'visible';
            }
            onLayoutComplete(crossings, collisions);
          }
        } else {
          const crossings = countCrossings(cy);
          const collisions = countNodeEdgeCollisions(cy, { minNodeDist });

          // Show container if it was hidden (quickMode or no autoOptimize)
          if (container && skipOptRender && container.style.visibility === 'hidden') {
            container.style.visibility = 'visible';
          }

          onLayoutComplete(crossings, collisions);
        }

        resolve();
      });

      layout.run();
    });

    return cy;
  }

  /**
   * Get default Cytoscape styles
   */
  function getDefaultStyles() {
    return [
      {
        selector: 'node',
        style: {
          'label': 'data(label)',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': '10px',
          'color': '#e0e0e0',
          'text-wrap': 'wrap',
          'text-max-width': '60px',
          'width': '30px',
          'height': '30px',
          'background-color': '#b0bec5',
          'border-color': '#1f1f1f',
          'border-width': 1
        }
      },
      {
        selector: 'node.center',
        style: {
          'background-color': '#ffd700',
          'color': '#000000'
        }
      },
      {
        selector: 'node.visited',
        style: {
          'background-color': '#b0bec5',
          'color': '#000000'
        }
      },
      {
        selector: 'node.unvisited',
        style: {
          'background-color': '#ef9a9a'
        }
      },
      {
        selector: 'edge',
        style: {
          'width': 1.25,
          'opacity': 0.85,
          'line-color': '#9aa0a6',
          'target-arrow-shape': 'data(targetArrow)',
          'source-arrow-shape': 'data(sourceArrow)',
          'target-arrow-color': '#9aa0a6',
          'source-arrow-color': '#9aa0a6',
          'arrow-scale': 1.2,
          'curve-style': 'straight'
        }
      }
    ];
  }

// Public API
export const GraphLayout = {
  render,
  runLayout,
  optimizeLayout,
  countCrossings,
  countNodeEdgeCollisions,
  createElements,
  getLayoutOptions,
  getDefaultStyles,
  toPairs
};

export default GraphLayout;