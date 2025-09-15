/**
 * Graph Layout Module
 *
 * Provides graph layout functionality using Cytoscape.js with fcose algorithm.
 * ES6 module for use in React/TypeScript applications.
 */

import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { fixCrossingsByRelocation } from './fixCrossingsByRelocation';

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
  function countAllCollisions(cyInstance, options = {}) {
    const minDist = options.minNodeDist || 4;
    const nodeRadius = minDist * 5;
    const minNodeDistance = nodeRadius * 2 + 4; // Use test file's standard
    const verbose = options.verbose || false;

    let nodeNodeCollisions = 0;
    let nodeEdgeCollisions = 0;

    // Check node-node collisions
    cyInstance.nodes().forEach((node1, i) => {
      cyInstance.nodes().slice(i + 1).forEach(node2 => {
        const pos1 = node1.position();
        const pos2 = node2.position();
        const distance = Math.sqrt(
          Math.pow(pos1.x - pos2.x, 2) +
          Math.pow(pos1.y - pos2.y, 2)
        );

        if (distance < minNodeDistance) {
          nodeNodeCollisions++;
          if (verbose) {
            console.log(`  Node-node collision: ${node1.id()} and ${node2.id()} are ${distance.toFixed(1)} apart (min: ${minNodeDistance})`);
          }
        }
      });
    });

    // Check node-edge collisions (existing logic)
    nodeEdgeCollisions = countNodeEdgeCollisions(cyInstance, options);

    return nodeNodeCollisions + nodeEdgeCollisions;
  }

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
   * Run Phase 1 optimization attempts
   * Returns best result from multiple layout attempts with parameter variation
   */
  async function runPhase1Optimization(cy, params) {
    const { minNodeDist, nodeRepulsion, maxAttempts, verbose } = params;

    let bestCrossings = Infinity;
    let bestCollisions = Infinity;
    let bestPositions = {};

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
      const newCollisions = countAllCollisions(cy, { minNodeDist });

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

    return { crossings: bestCrossings, collisions: bestCollisions, positions: bestPositions };
  }

  /**
   * Run Phase 2 intensive search for near-perfect layouts
   * Only runs when close to perfect (2-3 crossings)
   */
  async function runPhase2Optimization(cy, params) {
    const { minNodeDist, nodeRepulsion, initialCrossings, initialPositions, verbose } = params;

    if (verbose) {
      console.log(`\n  PHASE 2: Close to perfect (${initialCrossings} crossings) - trying intensive search...`);
    }

    let bestCrossings = initialCrossings;
    let bestCollisions = 0;
    let bestPositions = { ...initialPositions };

    // Try many more attempts with aggressive parameter variation
    const intensiveAttempts = 30;
    for (let attempt = 0; attempt < intensiveAttempts; attempt++) {
      // More aggressive parameter variation
      const repulsionMultiplier = 1.5 + (attempt % 10) * 0.5; // 1.5 to 6.0
      const iterCount = 15000 + (attempt % 5) * 5000; // 15000 to 35000
      const gravityValue = 0.02 + (attempt % 8) * 0.02; // 0.02 to 0.16

      const intensiveLayout = cy.layout({
        name: 'fcose',
        animate: false,
        randomize: true,
        quality: 'proof',
        numIter: iterCount,
        randomizationSeed: Math.floor(Math.random() * 100000),
        idealEdgeLength: edge => {
          const avgDegree = (edge.source().degree() + edge.target().degree()) / 2;
          const lengthMultiplier = 0.8 + (attempt % 5) * 0.1; // 0.8 to 1.2
          return Math.max(minNodeDist * 2, Math.min(minNodeDist * 10, (70 + avgDegree * 12) * lengthMultiplier));
        },
        nodeRepulsion: node => nodeRepulsion * repulsionMultiplier,
        nodeOverlap: minNodeDist + 10 + (attempt % 4) * 10, // More variation
        gravity: gravityValue,
        gravityRange: 10.0,
        edgeElasticity: edge => 0.15 + (attempt % 3) * 0.1, // 0.15 to 0.35
        initialTemp: 800 + (attempt % 4) * 200, // 800 to 1400
        coolingFactor: 0.99 + (attempt % 2) * 0.005, // 0.99 or 0.995
        improveFlow: true
      });

      await new Promise((resolve) => {
        intensiveLayout.on('layoutstop', resolve);
        intensiveLayout.run();
      });

      // Apply quick post-processing to this attempt
      let tempCrossings = countCrossings(cy);
      let tempCollisions = countAllCollisions(cy, { minNodeDist });

      // Try node swapping on this attempt
      if (tempCrossings > 0 && tempCrossings <= 5) {
        const fixed = fixCrossingsBySwapping(cy, {
          verbose: false,
          minNodeDistance: minNodeDist * 10,
          aggressive: true,
          maxDegree: 15
        });
        if (fixed > 0) {
          tempCrossings = countCrossings(cy);
          tempCollisions = countAllCollisions(cy, { minNodeDist });
        }
      }

      // Fix any collisions that were created
      if (tempCollisions > 0 || tempCrossings === 0) {
        const nodeRadius = minNodeDist * 5;
        const minNodeDistance = nodeRadius * 2 + 4;
        let collisionPasses = 0;
        const maxCollisionPasses = 3;

        while (collisionPasses < maxCollisionPasses) {
          collisionPasses++;
          let collisionsFixed = 0;

          // Fix node-node collisions
          cy.nodes().forEach(node1 => {
            cy.nodes().forEach(node2 => {
              if (node1.id() >= node2.id()) return;

              const pos1 = node1.position();
              const pos2 = node2.position();
              const distance = Math.sqrt(
                Math.pow(pos1.x - pos2.x, 2) +
                Math.pow(pos1.y - pos2.y, 2)
              );

              if (distance < minNodeDistance) {
                const pushDistance = (minNodeDistance - distance) / 2 + 10;
                if (distance > 0.01) {
                  const angle = Math.atan2(pos2.y - pos1.y, pos2.x - pos1.x);
                  node1.position({
                    x: pos1.x - Math.cos(angle) * pushDistance,
                    y: pos1.y - Math.sin(angle) * pushDistance
                  });
                  node2.position({
                    x: pos2.x + Math.cos(angle) * pushDistance,
                    y: pos2.y + Math.sin(angle) * pushDistance
                  });
                } else {
                  node1.position({ x: pos1.x - pushDistance, y: pos1.y });
                  node2.position({ x: pos2.x + pushDistance, y: pos2.y });
                }
                collisionsFixed++;
              }
            });
          });

          // Fix node-edge collisions
          cy.nodes().forEach(node => {
            const nodePos = node.position();
            cy.edges().forEach(edge => {
              if (edge.source().id() === node.id() || edge.target().id() === node.id()) {
                return;
              }

              const srcPos = edge.source().position();
              const tgtPos = edge.target().position();
              const edgeVec = { x: tgtPos.x - srcPos.x, y: tgtPos.y - srcPos.y };
              const edgeLen = Math.sqrt(edgeVec.x * edgeVec.x + edgeVec.y * edgeVec.y);

              if (edgeLen === 0) return;

              const t = Math.max(0, Math.min(1,
                ((nodePos.x - srcPos.x) * edgeVec.x + (nodePos.y - srcPos.y) * edgeVec.y) / (edgeLen * edgeLen)
              ));

              if (t > 0.1 && t < 0.9) {
                const closestPoint = {
                  x: srcPos.x + t * edgeVec.x,
                  y: srcPos.y + t * edgeVec.y
                };

                const distance = Math.sqrt(
                  Math.pow(nodePos.x - closestPoint.x, 2) +
                  Math.pow(nodePos.y - closestPoint.y, 2)
                );

                const threshold = nodeRadius + minNodeDist;
                if (distance < threshold) {
                  const pushDist = threshold - distance + 5;
                  const angle = Math.atan2(nodePos.y - closestPoint.y, nodePos.x - closestPoint.x);

                  node.position({
                    x: nodePos.x + Math.cos(angle) * pushDist,
                    y: nodePos.y + Math.sin(angle) * pushDist
                  });

                  collisionsFixed++;
                }
              }
            });
          });

          if (collisionsFixed === 0) break;
        }

        // Recount after collision resolution
        tempCrossings = countCrossings(cy);
        tempCollisions = countAllCollisions(cy, { minNodeDist });
      }

      if (tempCrossings === 0 && tempCollisions === 0) {
        // Perfect!
        cy.nodes().forEach(node => {
          bestPositions[node.id()] = node.position();
        });
        bestCrossings = 0;
        bestCollisions = 0;
        if (verbose) {
          console.log(`  PHASE 2 SUCCESS: Perfect layout found at attempt ${attempt + 1}!`);
        }
        break;
      } else if (tempCrossings < bestCrossings || (tempCrossings === bestCrossings && tempCollisions < bestCollisions)) {
        // Better than before
        bestCrossings = tempCrossings;
        bestCollisions = tempCollisions;
        cy.nodes().forEach(node => {
          bestPositions[node.id()] = node.position();
        });
        if (verbose && tempCrossings < initialCrossings) {
          console.log(`  Phase 2 attempt ${attempt + 1}: Improved to ${tempCrossings} crossings, ${tempCollisions} collisions`);
        }
      }

      // Restore positions for next attempt
      if (tempCrossings > bestCrossings || (tempCrossings === bestCrossings && tempCollisions > bestCollisions)) {
        cy.nodes().forEach(node => {
          node.position(bestPositions[node.id()]);
        });
      }
    }

    if (verbose) {
      if (bestCrossings < initialCrossings) {
        console.log(`  Phase 2 improved from ${initialCrossings} to ${bestCrossings} crossings`);
      } else {
        console.log(`  Phase 2 couldn't improve beyond ${bestCrossings} crossings`);
      }
    }

    // Restore best positions
    cy.nodes().forEach(node => {
      node.position(bestPositions[node.id()]);
    });

    return { crossings: bestCrossings, collisions: bestCollisions, positions: bestPositions };
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
    const initialCollisions = countAllCollisions(cy, { minNodeDist });

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
      // REDUCED max attempts - rely on collision resolution & Fix Regions
      let actualMaxAttempts = maxOptimizeAttempts;
      if (enhancedOptimization && (initialCollisions > 0 || initialCrossings > 0)) {
        if (initialCrossings >= 3) {
          // Multiple crossings need more attempts, but cap at 30
          actualMaxAttempts = Math.max(maxOptimizeAttempts, 30);
        } else if (initialCrossings > 0) {
          // Some crossings
          if (nodes.length <= 6) {
            actualMaxAttempts = Math.max(maxOptimizeAttempts, 25);
          } else {
            actualMaxAttempts = Math.max(maxOptimizeAttempts, 20);
          }
        } else if (initialCollisions > 0) {
          // Just collisions - collision resolution will handle
          actualMaxAttempts = Math.max(maxOptimizeAttempts, 15);
        }
        if (verbose) {
          console.log(`  Using enhanced optimization with ${actualMaxAttempts} attempts`);
        }
      }

      // Run Phase 1 optimization
      const phase1Result = await runPhase1Optimization(cy, {
        minNodeDist,
        nodeRepulsion,
        maxAttempts: actualMaxAttempts,
        verbose
      });

      bestCrossings = phase1Result.crossings;
      bestCollisions = phase1Result.collisions;
      bestPositions = phase1Result.positions;

      // Try node swapping if we still have crossings
      if (bestCrossings > 0 && enhancedOptimization) {
        if (verbose) {
          console.log(`  Trying node swapping to fix ${bestCrossings} remaining crossings...`);
        }

        // Use aggressive mode for graphs with persistent crossings
        const isSmallGraph = nodes.length <= 8;
        const isMediumGraph = nodes.length <= 25;

        const fixed = fixCrossingsBySwapping(cy, {
          verbose: verbose,
          minNodeDistance: minNodeDist * 10, // Use a reasonable distance based on node size
          aggressive: (isSmallGraph && bestCrossings > 1) || (isMediumGraph && bestCrossings >= 3),
          maxDegree: isSmallGraph ? 20 : (isMediumGraph ? 15 : 10)
        });

        if (fixed > 0) {
          bestCrossings = countCrossings(cy);
          bestCollisions = countAllCollisions(cy, { minNodeDist });
          if (verbose) {
            console.log(`  After node swapping: ${bestCrossings} crossings, ${bestCollisions} collisions`);
          }
        }
      }

      // Try flipping nodes if we still have crossings
      if (bestCrossings > 0 && enhancedOptimization) {
        if (verbose) {
          console.log(`  Trying node flipping to fix ${bestCrossings} remaining crossings...`);
        }

        const flipped = fixCrossingsByFlipping(cy, {
          verbose: verbose,
          maxFlips: 20,
          minNodeDist: minNodeDist
        });

        if (flipped > 0) {
          bestCrossings = countCrossings(cy);
          bestCollisions = countAllCollisions(cy, { minNodeDist });
          if (verbose) {
            console.log(`  After node flipping: ${bestCrossings} crossings, ${bestCollisions} collisions`);
          }
        }
      }

      // Try relocating nodes that cross edges they're not connected to
      // Skip if we're already at 1 crossing (likely optimal)
      if (bestCrossings > 1 && enhancedOptimization) {
        if (verbose) {
          console.log(`  Trying node relocation to fix ${bestCrossings} remaining crossings...`);
        }

        const beforeRelocationCrossings = bestCrossings;
        const beforeRelocationPositions = {};
        cy.nodes().forEach(node => {
          beforeRelocationPositions[node.id()] = node.position();
        });

        const relocated = fixCrossingsByRelocation(cy, {
          verbose: verbose,
          minNodeDist: minNodeDist
        });

        if (relocated > 0) {
          bestCrossings = countCrossings(cy);
          bestCollisions = countAllCollisions(cy, { minNodeDist });

          // If relocation made it worse, revert
          if (bestCrossings > beforeRelocationCrossings) {
            cy.nodes().forEach(node => {
              node.position(beforeRelocationPositions[node.id()]);
            });
            bestCrossings = beforeRelocationCrossings;
            bestCollisions = countAllCollisions(cy, { minNodeDist });
            if (verbose) {
              console.log(`  Node relocation made it worse, reverted`);
            }
          } else {
            if (verbose) {
              console.log(`  After node relocation: ${bestCrossings} crossings, ${bestCollisions} collisions`);
            }
          }
        }
      } else if (bestCrossings === 1 && verbose) {
        console.log(`  Skipping node relocation (already at 1 crossing - likely optimal)`);
      }

      // Try Fix Regions if we still have crossings (not just collisions)
      // Fix Regions is for topological issues, not spacing issues
      // Skip if at 1 crossing - likely optimal
      if (bestCrossings > 1 && enhancedOptimization) {
        if (verbose) {
          console.log(`  Trying Fix Regions to fix ${bestCrossings} crossings...`);
        }

        const nodesMoved = fixRegions(cy, {
          verbose: verbose
        });

        if (nodesMoved > 0) {
          bestCrossings = countCrossings(cy);
          bestCollisions = countAllCollisions(cy, { minNodeDist });
          if (verbose) {
            console.log(`  After Fix Regions: ${bestCrossings} crossings, ${bestCollisions} collisions`);
          }

          // If Fix Regions created collisions, run a quick layout to resolve them
          if (bestCollisions > 0) {
            if (verbose) {
              console.log(`  Fix Regions created ${bestCollisions} collisions, running quick adjustment...`);
            }

            // Save current positions
            const preAdjustPositions = {};
            cy.nodes().forEach(node => {
              preAdjustPositions[node.id()] = node.position();
            });

            // Run a gentle layout adjustment
            const adjustLayout = cy.layout({
              name: 'fcose',
              animate: false,
              randomize: false,
              quality: 'proof',
              numIter: 500,
              idealEdgeLength: edge => minNodeDist * 10,
              nodeRepulsion: node => nodeRepulsion * 0.5,
              nodeOverlap: minNodeDist + 20,
              gravity: 0.05,
              edgeElasticity: edge => 0.1,
              initialTemp: 100,
              coolingFactor: 0.99
            });

            await new Promise((resolve) => {
              adjustLayout.on('layoutstop', resolve);
              adjustLayout.run();
            });

            const adjustedCrossings = countCrossings(cy);
            const adjustedCollisions = countAllCollisions(cy, { minNodeDist });

            // Only keep adjustment if it didn't make things worse
            if (adjustedCrossings <= bestCrossings && adjustedCollisions < bestCollisions) {
              bestCrossings = adjustedCrossings;
              bestCollisions = adjustedCollisions;
              if (verbose) {
                console.log(`  After adjustment: ${bestCrossings} crossings, ${bestCollisions} collisions`);
              }
            } else {
              // Restore positions
              cy.nodes().forEach(node => {
                node.position(preAdjustPositions[node.id()]);
              });
              if (verbose) {
                console.log(`  Adjustment made things worse, restored positions`);
              }
            }
          }
        }
      }

      // Final comprehensive collision resolution - fix ALL collisions including node-node
      if (enhancedOptimization) {
        const nodeRadius = minNodeDist * 5;
        const minNodeDistance = nodeRadius * 2 + 4; // Use test file's standard (44 pixels)
        let maxPasses = 5;
        let pass = 0;

        while (pass < maxPasses) {
          pass++;
          let collisionsFixed = 0;

          // First fix node-node collisions
          cy.nodes().forEach(node1 => {
            cy.nodes().forEach(node2 => {
              if (node1.id() >= node2.id()) return; // Check each pair once

              const pos1 = node1.position();
              const pos2 = node2.position();
              const distance = Math.sqrt(
                Math.pow(pos1.x - pos2.x, 2) +
                Math.pow(pos1.y - pos2.y, 2)
              );

              if (distance < minNodeDistance) {
                // Nodes are too close, push them apart
                const pushDistance = (minNodeDistance - distance) / 2 + 10; // Add extra buffer

                if (distance > 0.01) { // Avoid division by zero
                  const angle = Math.atan2(pos2.y - pos1.y, pos2.x - pos1.x);

                  // Move both nodes away from each other
                  node1.position({
                    x: pos1.x - Math.cos(angle) * pushDistance,
                    y: pos1.y - Math.sin(angle) * pushDistance
                  });

                  node2.position({
                    x: pos2.x + Math.cos(angle) * pushDistance,
                    y: pos2.y + Math.sin(angle) * pushDistance
                  });
                } else {
                  // Nodes are at same position, move them in opposite directions
                  node1.position({
                    x: pos1.x - pushDistance,
                    y: pos1.y
                  });
                  node2.position({
                    x: pos2.x + pushDistance,
                    y: pos2.y
                  });
                }

                collisionsFixed++;
                if (verbose) {
                  console.log(`  Pass ${pass}: Fixed node-node collision between ${node1.id()} and ${node2.id()} (distance was ${distance.toFixed(1)})`);
                }
              }
            });
          });

          // Then fix node-edge collisions
          const edgeCollisions = countAllCollisions(cy, { minNodeDist });
          if (edgeCollisions > 0) {
            // Use existing collision resolution logic
            cy.nodes().forEach(node => {
              const nodePos = node.position();
              cy.edges().forEach(edge => {
                if (edge.source().id() === node.id() || edge.target().id() === node.id()) {
                  return;
                }

                const srcPos = edge.source().position();
                const tgtPos = edge.target().position();

                // Calculate distance from node to edge
                const edgeVec = { x: tgtPos.x - srcPos.x, y: tgtPos.y - srcPos.y };
                const edgeLen = Math.sqrt(edgeVec.x * edgeVec.x + edgeVec.y * edgeVec.y);

                if (edgeLen === 0) return;

                const t = Math.max(0, Math.min(1,
                  ((nodePos.x - srcPos.x) * edgeVec.x + (nodePos.y - srcPos.y) * edgeVec.y) / (edgeLen * edgeLen)
                ));

                // Only check middle portion of edge
                if (t > 0.1 && t < 0.9) {
                  const closestPoint = {
                    x: srcPos.x + t * edgeVec.x,
                    y: srcPos.y + t * edgeVec.y
                  };

                  const distance = Math.sqrt(
                    Math.pow(nodePos.x - closestPoint.x, 2) +
                    Math.pow(nodePos.y - closestPoint.y, 2)
                  );

                  const threshold = nodeRadius + minNodeDist;
                  if (distance < threshold) {
                    // Push node away from edge
                    const pushDist = threshold - distance + 5;
                    const angle = Math.atan2(nodePos.y - closestPoint.y, nodePos.x - closestPoint.x);

                    node.position({
                      x: nodePos.x + Math.cos(angle) * pushDist,
                      y: nodePos.y + Math.sin(angle) * pushDist
                    });

                    collisionsFixed++;
                  }
                }
              });
            });
          }

          if (collisionsFixed === 0) {
            // No more collisions to fix
            break;
          }

          if (verbose && collisionsFixed > 0) {
            console.log(`  Pass ${pass}: Fixed ${collisionsFixed} collisions`);
          }
        }

        // Update final metrics
        bestCrossings = countCrossings(cy);
        bestCollisions = countAllCollisions(cy, { minNodeDist });

        if (verbose) {
          console.log(`  Collision resolution complete after ${pass} passes`);
          console.log(`  Final: ${bestCrossings} crossings, ${bestCollisions} collisions`);
        }
      }

      // Get final positions for return
      let positions = {};
      cy.nodes().forEach(node => {
        positions[node.id()] = node.position();
      });

      // PHASE 2: Intensive search if we're close to perfect
      if (enhancedOptimization && bestCrossings > 0 && bestCrossings <= 3 && bestCollisions === 0) {
        const phase2Result = await runPhase2Optimization(cy, {
          minNodeDist,
          nodeRepulsion,
          initialCrossings: bestCrossings,
          initialPositions: positions,
          verbose
        });

        bestCrossings = phase2Result.crossings;
        bestCollisions = phase2Result.collisions;
        positions = phase2Result.positions;
      }

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
   * Render with optimized layout algorithm (uses runLayout instead of optimizeLayout)
   * This provides better results for complex graphs
   */
  async function renderOptimized(nodes, centerId, options = {}) {
    const container = options.container;
    const minNodeDist = options.minNodeDist || 4;
    const nodeRepulsion = options.nodeRepulsion || 20003; // Higher for better results
    const styles = options.styles || getDefaultStyles();
    const onLayoutComplete = options.onLayoutComplete || (() => {});

    // First run the optimized layout algorithm
    const layoutResult = await runLayout(nodes, centerId, {
      verbose: container ? true : false,
      minNodeDist,
      nodeRepulsion,
      maxOptimizeAttempts: 20,
      enhancedOptimization: true
    });

    // Create Cytoscape instance with the optimized positions
    const elements = createElements(nodes, centerId);

    // Apply the optimized positions to elements
    elements.forEach(element => {
      // Only apply positions to nodes (not edges)
      if (!element.data.source && !element.data.target) {
        const pos = layoutResult.positions[element.data.id];
        if (pos) {
          element.position = pos;
        }
      }
    });

    const cy = cytoscape({
      container: container,
      elements: elements,
      style: styles,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      autoungrabify: false,
      layout: { name: 'preset' } // Use preset since we already have positions
    });

    // Report final metrics
    onLayoutComplete(layoutResult.crossings, layoutResult.collisions);

    return cy;
  }

  /**
   * Fix regions by detecting cycles and moving nodes to correct topological positions
   * Returns the number of nodes moved
   */
  function fixRegions(cy, options = {}) {
    const verbose = options.verbose || false;

    if (verbose) {
      console.log(`Fix Regions: Graph has ${cy.nodes().length} nodes and ${cy.edges().length} edges`);
    }

    // Find cycles in the graph
    const findCycles = () => {
      const cycles = [];
      const nodes = cy.nodes();
      const cycleSet = new Set();

      // Find 3-cycles (triangles)
      nodes.forEach((n1) => {
        const n1Neighbors = n1.neighborhood().nodes();
        n1Neighbors.forEach((n2) => {
          if (parseInt(n2.id()) <= parseInt(n1.id())) return;

          n1Neighbors.forEach((n3) => {
            if (n3.id() === n2.id()) return;
            if (parseInt(n3.id()) <= parseInt(n1.id())) return;

            const n2Neighbors = n2.neighborhood().nodes();
            if (n2Neighbors.some((n) => n.id() === n3.id())) {
              const cycleIds = [n1.id(), n2.id(), n3.id()]
                .map(id => parseInt(id))
                .sort((a, b) => a - b)
                .join('-');

              if (!cycleSet.has(cycleIds)) {
                cycleSet.add(cycleIds);
                cycles.push([n1, n2, n3]);
                if (verbose) {
                  console.log(`Found 3-cycle: ${n1.id()} -> ${n2.id()} -> ${n3.id()}`);
                }
              }
            }
          });
        });
      });

      // Find 4-cycles (boxes)
      nodes.forEach((n1) => {
        const n1Neighbors = n1.neighborhood().nodes();

        n1Neighbors.forEach((n2) => {
          if (parseInt(n2.id()) <= parseInt(n1.id())) return;

          const n2Neighbors = n2.neighborhood().nodes();

          n1Neighbors.forEach((n3) => {
            if (n3.id() === n2.id()) return;
            if (parseInt(n3.id()) <= parseInt(n1.id())) return;

            const n3Neighbors = n3.neighborhood().nodes();

            n2Neighbors.forEach((n4) => {
              if (n4.id() === n1.id() || n4.id() === n2.id() || n4.id() === n3.id()) return;

              if (n3Neighbors.some((n) => n.id() === n4.id())) {
                const cycleIds = [n1.id(), n2.id(), n3.id(), n4.id()]
                  .map(id => parseInt(id))
                  .sort((a, b) => a - b)
                  .join('-');

                if (!cycleSet.has(cycleIds)) {
                  cycleSet.add(cycleIds);
                  cycles.push([n1, n2, n4, n3]);
                  if (verbose) {
                    console.log(`Found 4-cycle: ${n1.id()} -> ${n2.id()} -> ${n4.id()} -> ${n3.id()}`);
                  }
                }
              }
            });
          });
        });
      });

      if (verbose) {
        console.log(`Total cycles found: ${cycles.length}`);
      }

      // Sort cycles by size - handle triangles first
      cycles.sort((a, b) => a.length - b.length);
      return cycles;
    };

    // Determine if a node should be inside or outside a cycle
    const getNodePlacement = (node, cycle) => {
      const isTriangle = cycle.length === 3;

      // Check connections to cycle nodes
      let connections = 0;
      const connectedCycleNodes = [];
      cycle.forEach(cycleNode => {
        if (node.neighborhood().nodes().some((n) => n.id() === cycleNode.id())) {
          connections++;
          connectedCycleNodes.push(cycleNode);
        }
      });

      // Count non-cycle connections
      const nonCycleConnections = node.neighborhood().nodes().filter((n) =>
        !cycle.some(cn => cn.id() === n.id())
      ).length;

      // Get cycle center
      let centerX = 0, centerY = 0;
      cycle.forEach(n => {
        const pos = n.position();
        centerX += pos.x;
        centerY += pos.y;
      });
      centerX /= cycle.length;
      centerY /= cycle.length;

      // Check if node is currently inside
      const nodePos = node.position();
      const distToCenter = Math.sqrt(
        Math.pow(nodePos.x - centerX, 2) +
        Math.pow(nodePos.y - centerY, 2)
      );

      let avgCycleDistance = 0;
      cycle.forEach(n => {
        const pos = n.position();
        avgCycleDistance += Math.sqrt(
          Math.pow(pos.x - centerX, 2) +
          Math.pow(pos.y - centerY, 2)
        );
      });
      avgCycleDistance /= cycle.length;

      const insideThreshold = isTriangle ? 0.6 : 0.8;
      const isCurrentlyInside = distToCenter < avgCycleDistance * insideThreshold;

      // Decision logic
      if (connections >= 3) {
        // Connected to 3+ cycle nodes: should be inside
        if (!isCurrentlyInside) {
          if (verbose) {
            console.log(`Node ${node.id()} should move INSIDE: ${connections} cycle connections`);
          }
          return 'inside';
        }
      } else if (connections === 2) {
        if (isTriangle) {
          // For triangles, be conservative
          return 'unchanged';
        }

        if (nonCycleConnections === 0) {
          // Check if connected to adjacent cycle nodes
          const connectedIndices = connectedCycleNodes.map(cn =>
            cycle.findIndex(cycleNode => cycleNode.id() === cn.id())
          );

          const areAdjacent = connectedIndices.length === 2 &&
            (Math.abs(connectedIndices[0] - connectedIndices[1]) === 1 ||
             Math.abs(connectedIndices[0] - connectedIndices[1]) === cycle.length - 1);

          if (!areAdjacent && !isCurrentlyInside) {
            // Connected to non-adjacent cycle nodes - should be inside
            if (verbose) {
              console.log(`Node ${node.id()} should move INSIDE: 2 non-adjacent cycle connections`);
            }
            return 'inside';
          }
        } else if (nonCycleConnections <= 1 && !isCurrentlyInside) {
          if (verbose) {
            console.log(`Node ${node.id()} should move INSIDE: 2 cycle connections, ${nonCycleConnections} external`);
          }
          return 'inside';
        }
      } else if (connections === 1 && nonCycleConnections >= 1) {
        if (isCurrentlyInside) {
          if (verbose) {
            console.log(`Node ${node.id()} should move OUTSIDE: only 1 cycle connection`);
          }
          return 'outside';
        }
      } else if (connections === 0) {
        if (isCurrentlyInside) {
          if (verbose) {
            console.log(`Node ${node.id()} should move OUTSIDE: no cycle connections`);
          }
          return 'outside';
        }
      }

      return 'unchanged';
    };

    // Place node inside a cycle
    const placeInside = (node, cycle) => {
      let centerX = 0, centerY = 0;
      cycle.forEach(n => {
        const pos = n.position();
        centerX += pos.x;
        centerY += pos.y;
      });
      centerX /= cycle.length;
      centerY /= cycle.length;

      // Calculate average radius of the cycle
      const avgCycleDist = cycle.reduce((sum, cycleNode) => {
        const cPos = cycleNode.position();
        return sum + Math.sqrt(Math.pow(cPos.x - centerX, 2) + Math.pow(cPos.y - centerY, 2));
      }, 0) / cycle.length;

      // Count nodes already inside
      const nodesAlreadyInside = cy.nodes().filter((n) => {
        if (n.id() === node.id()) return false;
        const pos = n.position();
        const distToCenter = Math.sqrt(Math.pow(pos.x - centerX, 2) + Math.pow(pos.y - centerY, 2));
        return distToCenter < avgCycleDist * 0.7;
      });

      const currentPos = node.position();
      let newX, newY;

      // For 4-cycles with a node that needs to be inside (like 1148)
      // Place it more carefully to avoid edge collisions
      if (cycle.length === 4 && node.neighborhood().nodes().filter(n =>
          cycle.some(cn => cn.id() === n.id())).length >= 3) {
        // This node is connected to 3+ cycle nodes
        // Place it at a safe distance from center, considering cycle size
        const safeRadius = avgCycleDist * 0.4; // Not too close to center

        if (nodesAlreadyInside.length === 0) {
          // First node: place at center but not too close
          newX = centerX;
          newY = centerY;
        } else {
          // If there are already nodes inside, offset this one
          const angleStep = (Math.PI * 2) / (nodesAlreadyInside.length + 1);
          let bestAngle = 0;
          let maxMinDist = 0;

          // Find the angle that maximizes minimum distance to other nodes
          for (let a = 0; a < Math.PI * 2; a += angleStep) {
            const testX = centerX + Math.cos(a) * safeRadius;
            const testY = centerY + Math.sin(a) * safeRadius;

            let minDist = Infinity;
            [...cycle, ...nodesAlreadyInside].forEach(otherNode => {
              const oPos = otherNode.position();
              const dist = Math.sqrt(Math.pow(testX - oPos.x, 2) + Math.pow(testY - oPos.y, 2));
              minDist = Math.min(minDist, dist);
            });

            if (minDist > maxMinDist) {
              maxMinDist = minDist;
              bestAngle = a;
            }
          }

          newX = centerX + Math.cos(bestAngle) * safeRadius;
          newY = centerY + Math.sin(bestAngle) * safeRadius;
        }
      } else if (nodesAlreadyInside.length === 0) {
        // First node goes somewhat near center but not too close
        const safeRadius = avgCycleDist * 0.3;
        newX = centerX;
        newY = centerY;
      } else {
        // Offset subsequent nodes
        const angleOffset = (Math.PI * 2) / (nodesAlreadyInside.length + 1);
        const angle = angleOffset * nodesAlreadyInside.length;
        const offsetRadius = Math.min(avgCycleDist * 0.4, 50);

        newX = centerX + Math.cos(angle) * offsetRadius;
        newY = centerY + Math.sin(angle) * offsetRadius;
      }

      if (verbose) {
        console.log(`Moving node ${node.id()} INSIDE to (${newX.toFixed(0)}, ${newY.toFixed(0)})`);
      }
      node.position({ x: newX, y: newY });
    };

    // Place node outside a cycle
    const placeOutside = (node, cycle) => {
      let centerX = 0, centerY = 0;
      cycle.forEach(n => {
        const pos = n.position();
        centerX += pos.x;
        centerY += pos.y;
      });
      centerX /= cycle.length;
      centerY /= cycle.length;

      // Find connected cycle node
      let connectedCycleNode = null;
      cycle.forEach(cycleNode => {
        if (node.neighborhood().nodes().some((n) => n.id() === cycleNode.id())) {
          connectedCycleNode = cycleNode;
        }
      });

      if (connectedCycleNode) {
        const cycleNodePos = connectedCycleNode.position();
        const dirX = cycleNodePos.x - centerX;
        const dirY = cycleNodePos.y - centerY;
        const dirLength = Math.sqrt(dirX * dirX + dirY * dirY);

        if (dirLength > 0) {
          const newX = cycleNodePos.x + (dirX / dirLength) * 100;
          const newY = cycleNodePos.y + (dirY / dirLength) * 100;

          if (verbose) {
            console.log(`Moving node ${node.id()} OUTSIDE to (${newX.toFixed(0)}, ${newY.toFixed(0)})`);
          }
          node.position({ x: newX, y: newY });
        }
      } else {
        // Move away from center
        const currentPos = node.position();
        const dirX = currentPos.x - centerX;
        const dirY = currentPos.y - centerY;
        const dirLength = Math.sqrt(dirX * dirX + dirY * dirY);

        if (dirLength > 0) {
          const avgCycleDist = cycle.reduce((sum, cycleNode) => {
            const cPos = cycleNode.position();
            return sum + Math.sqrt(Math.pow(cPos.x - centerX, 2) + Math.pow(cPos.y - centerY, 2));
          }, 0) / cycle.length;

          const newDist = avgCycleDist * 1.5;
          const newX = centerX + (dirX / dirLength) * newDist;
          const newY = centerY + (dirY / dirLength) * newDist;

          if (verbose) {
            console.log(`Moving node ${node.id()} OUTSIDE to (${newX.toFixed(0)}, ${newY.toFixed(0)})`);
          }
          node.position({ x: newX, y: newY });
        }
      }
    };

    // Main logic
    const cycles = findCycles();
    let nodesMoved = 0;

    cycles.forEach(cycle => {
      const processedNodes = new Set();

      cy.nodes().forEach((node) => {
        // Skip cycle nodes themselves
        if (cycle.some((cn) => cn.id() === node.id())) return;

        // Skip already processed nodes
        if (processedNodes.has(node.id())) return;

        const placement = getNodePlacement(node, cycle);

        if (placement === 'inside') {
          placeInside(node, cycle);
          processedNodes.add(node.id());
          nodesMoved++;
        } else if (placement === 'outside') {
          placeOutside(node, cycle);
          processedNodes.add(node.id());
          nodesMoved++;
        }
      });
    });

    if (verbose) {
      console.log(`Fix Regions: Moved ${nodesMoved} nodes`);
    }

    return nodesMoved;
  }

  /**
   * Fix crossings by "flipping" nodes to the other side of edges they cross
   * Returns the number of flips applied
   */
  function fixCrossingsByFlipping(cy, options = {}) {
    const verbose = options.verbose || false;
    const maxFlips = options.maxFlips || 20;
    const minNodeDist = options.minNodeDist || 4;

    let totalFlips = 0;
    let pass = 0;
    const maxPasses = 5;  // More passes for thorough resolution

    // Helper: Calculate which side of a line a point is on
    const getSideOfLine = (point, lineStart, lineEnd) => {
      return (lineEnd.x - lineStart.x) * (point.y - lineStart.y) -
             (lineEnd.y - lineStart.y) * (point.x - lineStart.x);
    };

    // Helper: Mirror a point across a line
    const mirrorPointAcrossLine = (point, lineStart, lineEnd) => {
      const lineVec = {
        x: lineEnd.x - lineStart.x,
        y: lineEnd.y - lineStart.y
      };

      const lineLength = Math.sqrt(lineVec.x * lineVec.x + lineVec.y * lineVec.y);
      if (lineLength === 0) return point;

      const lineDir = {
        x: lineVec.x / lineLength,
        y: lineVec.y / lineLength
      };

      const toPoint = {
        x: point.x - lineStart.x,
        y: point.y - lineStart.y
      };

      const projection = lineDir.x * toPoint.x + lineDir.y * toPoint.y;
      const projectedPoint = {
        x: lineStart.x + lineDir.x * projection,
        y: lineStart.y + lineDir.y * projection
      };

      return {
        x: 2 * projectedPoint.x - point.x,
        y: 2 * projectedPoint.y - point.y
      };
    };

    while (pass < maxPasses && totalFlips < maxFlips) {
      pass++;
      let flipsThisPass = 0;
      const flipsToApply = [];

      if (verbose) {
        console.log(`Fix Crossings by Flipping - Pass ${pass}`);
      }

      // Find all edge crossings
      const edges = cy.edges();
      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
          const edge1 = edges[i];
          const edge2 = edges[j];

          const e1Src = edge1.source();
          const e1Tgt = edge1.target();
          const e2Src = edge2.source();
          const e2Tgt = edge2.target();

          // Skip if edges share a node
          if (e1Src.id() === e2Src.id() || e1Src.id() === e2Tgt.id() ||
              e1Tgt.id() === e2Src.id() || e1Tgt.id() === e2Tgt.id()) {
            continue;
          }

          const e1SrcPos = e1Src.position();
          const e1TgtPos = e1Tgt.position();
          const e2SrcPos = e2Src.position();
          const e2TgtPos = e2Tgt.position();

          // Check if edges cross using line segment intersection
          const ccw = (A, B, C) => {
            return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
          };

          const edgesCross = ccw(e1SrcPos, e2SrcPos, e2TgtPos) !== ccw(e1TgtPos, e2SrcPos, e2TgtPos) &&
                            ccw(e1SrcPos, e1TgtPos, e2SrcPos) !== ccw(e1SrcPos, e1TgtPos, e2TgtPos);

          if (edgesCross) {
            // Check if we can fix by flipping a node

            // Case 1: e1Src connected to edge2 endpoint - flip across edge2
            const e1SrcNeighbors = e1Src.neighborhood().nodes();
            if (e1SrcNeighbors.some(n => n.id() === e2Src.id() || n.id() === e2Tgt.id())) {
              const flippedPos = mirrorPointAcrossLine(e1SrcPos, e2SrcPos, e2TgtPos);

              // Test if flipping eliminates crossing
              const wouldCross = ccw(flippedPos, e2SrcPos, e2TgtPos) !== ccw(e1TgtPos, e2SrcPos, e2TgtPos) &&
                               ccw(flippedPos, e1TgtPos, e2SrcPos) !== ccw(flippedPos, e1TgtPos, e2TgtPos);

              if (!wouldCross) {
                flipsToApply.push({
                  node: e1Src,
                  oldPos: {...e1SrcPos},
                  newPos: flippedPos,
                  reason: `Flip ${e1Src.id()} across ${e2Src.id()}-${e2Tgt.id()}`
                });
              }
            }

            // Case 2: e1Tgt connected to edge2 endpoint - flip across edge2
            const e1TgtNeighbors = e1Tgt.neighborhood().nodes();
            if (e1TgtNeighbors.some(n => n.id() === e2Src.id() || n.id() === e2Tgt.id())) {
              const flippedPos = mirrorPointAcrossLine(e1TgtPos, e2SrcPos, e2TgtPos);

              const wouldCross = ccw(e1SrcPos, e2SrcPos, e2TgtPos) !== ccw(flippedPos, e2SrcPos, e2TgtPos) &&
                               ccw(e1SrcPos, flippedPos, e2SrcPos) !== ccw(e1SrcPos, flippedPos, e2TgtPos);

              if (!wouldCross) {
                flipsToApply.push({
                  node: e1Tgt,
                  oldPos: {...e1TgtPos},
                  newPos: flippedPos,
                  reason: `Flip ${e1Tgt.id()} across ${e2Src.id()}-${e2Tgt.id()}`
                });
              }
            }

            // Case 3: e2Src connected to edge1 endpoint - flip across edge1
            const e2SrcNeighbors = e2Src.neighborhood().nodes();
            if (e2SrcNeighbors.some(n => n.id() === e1Src.id() || n.id() === e1Tgt.id())) {
              const flippedPos = mirrorPointAcrossLine(e2SrcPos, e1SrcPos, e1TgtPos);

              const wouldCross = ccw(e1SrcPos, flippedPos, e2TgtPos) !== ccw(e1TgtPos, flippedPos, e2TgtPos) &&
                               ccw(e1SrcPos, e1TgtPos, flippedPos) !== ccw(e1SrcPos, e1TgtPos, e2TgtPos);

              if (!wouldCross) {
                flipsToApply.push({
                  node: e2Src,
                  oldPos: {...e2SrcPos},
                  newPos: flippedPos,
                  reason: `Flip ${e2Src.id()} across ${e1Src.id()}-${e1Tgt.id()}`
                });
              }
            }

            // Case 4: e2Tgt connected to edge1 endpoint - flip across edge1
            const e2TgtNeighbors = e2Tgt.neighborhood().nodes();
            if (e2TgtNeighbors.some(n => n.id() === e1Src.id() || n.id() === e1Tgt.id())) {
              const flippedPos = mirrorPointAcrossLine(e2TgtPos, e1SrcPos, e1TgtPos);

              const wouldCross = ccw(e1SrcPos, e2SrcPos, flippedPos) !== ccw(e1TgtPos, e2SrcPos, flippedPos) &&
                               ccw(e1SrcPos, e1TgtPos, e2SrcPos) !== ccw(e1SrcPos, e1TgtPos, flippedPos);

              if (!wouldCross) {
                flipsToApply.push({
                  node: e2Tgt,
                  oldPos: {...e2TgtPos},
                  newPos: flippedPos,
                  reason: `Flip ${e2Tgt.id()} across ${e1Src.id()}-${e1Tgt.id()}`
                });
              }
            }
          }
        }
      }

      // Apply beneficial flips
      const uniqueFlips = new Map();
      flipsToApply.forEach(flip => {
        if (!uniqueFlips.has(flip.node.id())) {
          uniqueFlips.set(flip.node.id(), flip);
        }
      });

      uniqueFlips.forEach(flip => {
        const beforeCrossings = countCrossings(cy);
        const beforeCollisions = countAllCollisions(cy, { minNodeDist });

        flip.node.position(flip.newPos);

        const afterCrossings = countCrossings(cy);
        const afterCollisions = countAllCollisions(cy, { minNodeDist });

        // Accept flip if it reduces crossings without creating collisions
        if (afterCrossings < beforeCrossings && afterCollisions <= beforeCollisions) {
          flipsThisPass++;
          totalFlips++;
          if (verbose) {
            console.log(`  Applied: ${flip.reason} (${beforeCrossings}→${afterCrossings} crossings)`);
          }
        } else {
          flip.node.position(flip.oldPos);
          if (verbose && afterCrossings >= beforeCrossings) {
            console.log(`  Rejected: ${flip.reason} (no improvement)`);
          }
        }
      });

      if (flipsThisPass === 0) break;
    }

    if (verbose && totalFlips > 0) {
      console.log(`Fix Crossings by Flipping: ${totalFlips} flips applied`);
    }

    return totalFlips;
  }

  /**
   * Fix edge crossings by swapping node positions
   * Returns the number of crossings eliminated
   */
  function fixCrossingsBySwapping(cy, options = {}) {
    const maxDegree = options.maxDegree || 10; // Only swap nodes with degree <= this
    const minNodeDistance = options.minNodeDistance || 50;
    const verbose = options.verbose || false;
    const aggressive = options.aggressive || false; // Try all pairs, not just crossing ones

    let totalFixed = 0;
    let iterations = 0;
    const maxIterations = aggressive ? 20 : 10; // More iterations in aggressive mode

    while (iterations < maxIterations) {
      iterations++;
      const initialCrossings = countCrossings(cy);

      if (initialCrossings === 0) {
        if (verbose) console.log('No crossings to fix');
        break;
      }

      if (verbose) console.log(`Fix Crossings iteration ${iterations}: ${initialCrossings} crossings`);

      // Find all edge pairs that cross
      const crossingPairs = [];
      const edges = cy.edges();

      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
          const e1 = edges[i];
          const e2 = edges[j];

          // Skip if edges share a node
          if (e1.source().id() === e2.source().id() ||
              e1.source().id() === e2.target().id() ||
              e1.target().id() === e2.source().id() ||
              e1.target().id() === e2.target().id()) {
            continue;
          }

          // Check if edges cross
          const p1 = e1.source().position();
          const p2 = e1.target().position();
          const p3 = e2.source().position();
          const p4 = e2.target().position();

          const ccw = (A, B, C) => {
            const val = (C.y - A.y) * (B.x - A.x) - (B.y - A.y) * (C.x - A.x);
            return Math.abs(val) < 1e-10 ? false : val > 0;
          };

          if (ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4)) {
            crossingPairs.push({ e1, e2 });
          }
        }
      }

      if (verbose) console.log(`Found ${crossingPairs.length} crossing edge pairs`);

      // Try swapping nodes to fix crossings
      let bestSwap = null;
      let bestReduction = 0;

      // For each crossing pair, try swapping the involved nodes
      for (const { e1, e2 } of crossingPairs) {
        const nodesToTry = [
          [e1.source(), e2.source()],
          [e1.source(), e2.target()],
          [e1.target(), e2.source()],
          [e1.target(), e2.target()]
        ];

        for (const [node1, node2] of nodesToTry) {
          // Skip high-degree nodes
          if (node1.degree() > maxDegree || node2.degree() > maxDegree) continue;

          // Skip if nodes are the same
          if (node1.id() === node2.id()) continue;

          // Save original positions
          const pos1 = { ...node1.position() };
          const pos2 = { ...node2.position() };

          // Try the swap
          node1.position(pos2);
          node2.position(pos1);

          // Count new crossings
          const newCrossings = countCrossings(cy);
          const reduction = initialCrossings - newCrossings;

          // Check for node overlaps
          let hasOverlap = false;
          cy.nodes().forEach(otherNode => {
            if (otherNode.id() === node1.id() || otherNode.id() === node2.id()) return;

            const otherPos = otherNode.position();

            // Check distance from node1's new position
            const dist1 = Math.sqrt(
              Math.pow(pos2.x - otherPos.x, 2) +
              Math.pow(pos2.y - otherPos.y, 2)
            );

            // Check distance from node2's new position
            const dist2 = Math.sqrt(
              Math.pow(pos1.x - otherPos.x, 2) +
              Math.pow(pos1.y - otherPos.y, 2)
            );

            if (dist1 < minNodeDistance || dist2 < minNodeDistance) {
              hasOverlap = true;
            }
          });

          // Track best swap
          if (reduction > bestReduction && !hasOverlap) {
            bestReduction = reduction;
            bestSwap = {
              node1: node1.id(),
              node2: node2.id(),
              pos1,
              pos2,
              reduction
            };
          }

          // Revert the swap for now
          node1.position(pos1);
          node2.position(pos2);
        }
      }

      // If no good swap found and we're in aggressive mode, try ALL pairs
      // Enhanced: Try on more iterations, not just the first
      if (!bestSwap && aggressive) {
        if (verbose) console.log(`  Aggressive mode: trying all node pairs (iteration ${iterations})...`);

        const allNodes = cy.nodes().filter(n => n.degree() <= maxDegree);

        for (let i = 0; i < allNodes.length; i++) {
          for (let j = i + 1; j < allNodes.length; j++) {
            const node1 = allNodes[i];
            const node2 = allNodes[j];

            const pos1 = { ...node1.position() };
            const pos2 = { ...node2.position() };

            // Try the swap
            node1.position(pos2);
            node2.position(pos1);

            const newCrossings = countCrossings(cy);
            const reduction = initialCrossings - newCrossings;

            // Check for overlaps only if swap helps
            let hasOverlap = false;
            if (reduction > 0) {
              cy.nodes().forEach(otherNode => {
                if (otherNode.id() === node1.id() || otherNode.id() === node2.id()) return;
                const otherPos = otherNode.position();
                const dist1 = Math.sqrt(Math.pow(pos2.x - otherPos.x, 2) + Math.pow(pos2.y - otherPos.y, 2));
                const dist2 = Math.sqrt(Math.pow(pos1.x - otherPos.x, 2) + Math.pow(pos1.y - otherPos.y, 2));
                if (dist1 < minNodeDistance || dist2 < minNodeDistance) {
                  hasOverlap = true;
                }
              });
            }

            if (reduction > bestReduction && !hasOverlap) {
              bestReduction = reduction;
              bestSwap = {
                node1: node1.id(),
                node2: node2.id(),
                pos1,
                pos2,
                reduction
              };
            }

            // Revert
            node1.position(pos1);
            node2.position(pos2);
          }
        }
      }

      // Apply the best swap if found
      if (bestSwap) {
        const node1 = cy.getElementById(bestSwap.node1);
        const node2 = cy.getElementById(bestSwap.node2);
        node1.position(bestSwap.pos2);
        node2.position(bestSwap.pos1);

        totalFixed += bestSwap.reduction;
        if (verbose) {
          console.log(`  Swapped ${bestSwap.node1} <-> ${bestSwap.node2}, reduced ${bestSwap.reduction} crossings`);
        }
      } else {
        // No beneficial swap found
        if (verbose) console.log('  No beneficial swaps found');
        break;
      }
    }

    if (verbose && totalFixed > 0) {
      console.log(`Fix Crossings eliminated ${totalFixed} total crossings in ${iterations} iterations`);
    }

    return totalFixed;
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
  renderOptimized,
  runLayout,
  countCrossings,
  countNodeEdgeCollisions,
  countAllCollisions,
  createElements,
  getLayoutOptions,
  getDefaultStyles,
  toPairs,
  fixCrossingsBySwapping
};

export default GraphLayout;