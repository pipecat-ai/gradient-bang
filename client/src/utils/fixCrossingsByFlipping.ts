/**
 * Fix edge crossings by "flipping" nodes to the other side of edges they cross
 * This handles cases where a node connected to one endpoint of an edge
 * creates a crossing that could be eliminated by moving it to the other side
 */

export function fixCrossingsByFlipping(cy: any, options: any = {}) {
  const verbose = options.verbose || false;
  const maxFlips = options.maxFlips || 10;

  let totalFlips = 0;
  let pass = 0;
  const maxPasses = 3;

  // Helper: Calculate which side of a line a point is on
  const getSideOfLine = (point: {x: number, y: number}, lineStart: {x: number, y: number}, lineEnd: {x: number, y: number}) => {
    // Cross product to determine side
    return (lineEnd.x - lineStart.x) * (point.y - lineStart.y) -
           (lineEnd.y - lineStart.y) * (point.x - lineStart.x);
  };

  // Helper: Check if two edges cross
  const edgesCross = (e1Src: any, e1Tgt: any, e2Src: any, e2Tgt: any) => {
    const ccw = (A: any, B: any, C: any) => {
      return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
    };

    return ccw(e1Src, e2Src, e2Tgt) !== ccw(e1Tgt, e2Src, e2Tgt) &&
           ccw(e1Src, e1Tgt, e2Src) !== ccw(e1Src, e1Tgt, e2Tgt);
  };

  // Helper: Mirror a point across a line
  const mirrorPointAcrossLine = (point: {x: number, y: number}, lineStart: {x: number, y: number}, lineEnd: {x: number, y: number}) => {
    // Vector from lineStart to lineEnd
    const lineVec = {
      x: lineEnd.x - lineStart.x,
      y: lineEnd.y - lineStart.y
    };

    const lineLength = Math.sqrt(lineVec.x * lineVec.x + lineVec.y * lineVec.y);
    if (lineLength === 0) return point;

    // Normalize line vector
    const lineDir = {
      x: lineVec.x / lineLength,
      y: lineVec.y / lineLength
    };

    // Vector from lineStart to point
    const toPoint = {
      x: point.x - lineStart.x,
      y: point.y - lineStart.y
    };

    // Project point onto line
    const projection = lineDir.x * toPoint.x + lineDir.y * toPoint.y;
    const projectedPoint = {
      x: lineStart.x + lineDir.x * projection,
      y: lineStart.y + lineDir.y * projection
    };

    // Mirror point across the projected point
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

        // Check if edges cross
        if (edgesCross(e1SrcPos, e1TgtPos, e2SrcPos, e2TgtPos)) {
          // Found a crossing - check if we can fix it by flipping

          // Case 1: e1Src is connected to e2Src or e2Tgt through other edges
          // and flipping e1Src to other side of edge2 would help
          const e1SrcConnectedTo = e1Src.neighborhood().nodes();

          // Check if e1Src should be flipped across edge2
          if (e1SrcConnectedTo.some(n => n.id() === e2Src.id() || n.id() === e2Tgt.id())) {
            // e1Src is connected to edge2 endpoints, consider flipping it
            const currentSide = getSideOfLine(e1SrcPos, e2SrcPos, e2TgtPos);

            // Calculate new position
            const flippedPos = mirrorPointAcrossLine(e1SrcPos, e2SrcPos, e2TgtPos);

            // Test if flipping would eliminate this crossing
            if (edgesCross(flippedPos, e1TgtPos, e2SrcPos, e2TgtPos) === false) {
              flipsToApply.push({
                node: e1Src,
                oldPos: e1SrcPos,
                newPos: flippedPos,
                reason: `Flip ${e1Src.id()} across edge ${e2Src.id()}-${e2Tgt.id()}`
              });
            }
          }

          // Case 2: Check e1Tgt
          const e1TgtConnectedTo = e1Tgt.neighborhood().nodes();
          if (e1TgtConnectedTo.some(n => n.id() === e2Src.id() || n.id() === e2Tgt.id())) {
            const flippedPos = mirrorPointAcrossLine(e1TgtPos, e2SrcPos, e2TgtPos);

            if (edgesCross(e1SrcPos, flippedPos, e2SrcPos, e2TgtPos) === false) {
              flipsToApply.push({
                node: e1Tgt,
                oldPos: e1TgtPos,
                newPos: flippedPos,
                reason: `Flip ${e1Tgt.id()} across edge ${e2Src.id()}-${e2Tgt.id()}`
              });
            }
          }

          // Similar checks for edge2 endpoints
          const e2SrcConnectedTo = e2Src.neighborhood().nodes();
          if (e2SrcConnectedTo.some(n => n.id() === e1Src.id() || n.id() === e1Tgt.id())) {
            const flippedPos = mirrorPointAcrossLine(e2SrcPos, e1SrcPos, e1TgtPos);

            if (edgesCross(e1SrcPos, e1TgtPos, flippedPos, e2TgtPos) === false) {
              flipsToApply.push({
                node: e2Src,
                oldPos: e2SrcPos,
                newPos: flippedPos,
                reason: `Flip ${e2Src.id()} across edge ${e1Src.id()}-${e1Tgt.id()}`
              });
            }
          }

          const e2TgtConnectedTo = e2Tgt.neighborhood().nodes();
          if (e2TgtConnectedTo.some(n => n.id() === e1Src.id() || n.id() === e1Tgt.id())) {
            const flippedPos = mirrorPointAcrossLine(e2TgtPos, e1SrcPos, e1TgtPos);

            if (edgesCross(e1SrcPos, e1TgtPos, e2SrcPos, flippedPos) === false) {
              flipsToApply.push({
                node: e2Tgt,
                oldPos: e2TgtPos,
                newPos: flippedPos,
                reason: `Flip ${e2Tgt.id()} across edge ${e1Src.id()}-${e1Tgt.id()}`
              });
            }
          }
        }
      }
    }

    // Remove duplicates (same node might be suggested for multiple flips)
    const uniqueFlips = new Map();
    flipsToApply.forEach(flip => {
      const nodeId = flip.node.id();
      if (!uniqueFlips.has(nodeId)) {
        uniqueFlips.set(nodeId, flip);
      }
    });

    // Apply flips that don't create new crossings
    uniqueFlips.forEach(flip => {
      const originalCrossings = countCrossings(cy);

      // Apply the flip
      flip.node.position(flip.newPos);

      // Count crossings after flip
      const newCrossings = countCrossings(cy);

      if (newCrossings < originalCrossings) {
        // Keep the flip
        flipsThisPass++;
        totalFlips++;
        if (verbose) {
          console.log(`  Applied: ${flip.reason} (${originalCrossings} → ${newCrossings} crossings)`);
        }
      } else {
        // Revert the flip
        flip.node.position(flip.oldPos);
        if (verbose && newCrossings > originalCrossings) {
          console.log(`  Rejected: ${flip.reason} (would create crossings)`);
        }
      }

      if (totalFlips >= maxFlips) return;
    });

    if (verbose) {
      console.log(`  Pass ${pass} complete: ${flipsThisPass} flips applied`);
    }

    // Stop if no progress made
    if (flipsThisPass === 0) break;
  }

  if (verbose) {
    console.log(`Fix Crossings by Flipping complete: ${totalFlips} total flips applied`);
  }

  return totalFlips;
}

// Helper function to count crossings (needs to be implemented in the context)
function countCrossings(cy: any): number {
  let crossings = 0;
  const edges = cy.edges();

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];

      const e1Src = e1.source();
      const e1Tgt = e1.target();
      const e2Src = e2.source();
      const e2Tgt = e2.target();

      // Skip if edges share a node
      if (e1Src.id() === e2Src.id() || e1Src.id() === e2Tgt.id() ||
          e1Tgt.id() === e2Src.id() || e1Tgt.id() === e2Tgt.id()) {
        continue;
      }

      const e1SrcPos = e1Src.position();
      const e1TgtPos = e1Tgt.position();
      const e2SrcPos = e2Src.position();
      const e2TgtPos = e2Tgt.position();

      // Check if edges cross
      const ccw = (A: any, B: any, C: any) => {
        return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
      };

      if (ccw(e1SrcPos, e2SrcPos, e2TgtPos) !== ccw(e1TgtPos, e2SrcPos, e2TgtPos) &&
          ccw(e1SrcPos, e1TgtPos, e2SrcPos) !== ccw(e1SrcPos, e1TgtPos, e2TgtPos)) {
        crossings++;
      }
    }
  }

  return crossings;
}