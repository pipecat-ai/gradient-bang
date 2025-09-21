/**
 * Fix crossings by relocating nodes even when they're not directly connected
 * This handles cases like sector 49 where node 4455 needs to move to avoid crossing 545-1448
 */

export function fixCrossingsByRelocation(cy: any, options: any = {}) {
  const verbose = options.verbose || false;
  const minNodeDist = options.minNodeDist || 4;
  let relocations = 0;

  // Helper to check if edges cross
  const edgesCross = (p1: any, p2: any, p3: any, p4: any) => {
    const ccw = (A: any, B: any, C: any) => {
      return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
    };
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) &&
           ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  };

  // Helper to check if a position would cause node collisions
  const wouldCauseNodeCollision = (node: any, testPos: any) => {
    const nodeRadius = minNodeDist * 5; // Approximate node radius
    const minDistance = nodeRadius * 2 + minNodeDist;

    let hasCollision = false;
    cy.nodes().forEach((otherNode: any) => {
      if (otherNode.id() === node.id()) return;

      const otherPos = otherNode.position();
      const distance = Math.sqrt(
        Math.pow(testPos.x - otherPos.x, 2) +
        Math.pow(testPos.y - otherPos.y, 2)
      );

      if (distance < minDistance) {
        hasCollision = true;
      }
    });

    return hasCollision;
  };

  // Find all crossings
  const edges = cy.edges();
  const crossings = [];

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

      const e1SrcPos = e1.source().position();
      const e1TgtPos = e1.target().position();
      const e2SrcPos = e2.source().position();
      const e2TgtPos = e2.target().position();

      if (edgesCross(e1SrcPos, e1TgtPos, e2SrcPos, e2TgtPos)) {
        crossings.push({
          edge1: e1,
          edge2: e2,
          nodes: [e1.source(), e1.target(), e2.source(), e2.target()]
        });
      }
    }
  }

  if (verbose) {
    console.log(`Fix Crossings by Relocation: Found ${crossings.length} crossings`);
  }

  // For each crossing, try relocating nodes
  crossings.forEach(crossing => {
    const e1Src = crossing.edge1.source();
    const e1Tgt = crossing.edge1.target();
    const e2Src = crossing.edge2.source();
    const e2Tgt = crossing.edge2.target();

    // Try relocating each node involved
    [e1Src, e1Tgt, e2Src, e2Tgt].forEach(node => {
      const currentPos = node.position();

      // Calculate where this node should be to avoid the crossing
      // Strategy: Move the node perpendicular to its edge

      let otherEdge = null;
      let myPartner = null;

      if (node.id() === e1Src.id()) {
        otherEdge = crossing.edge2;
        myPartner = e1Tgt;
      } else if (node.id() === e1Tgt.id()) {
        otherEdge = crossing.edge2;
        myPartner = e1Src;
      } else if (node.id() === e2Src.id()) {
        otherEdge = crossing.edge1;
        myPartner = e2Tgt;
      } else if (node.id() === e2Tgt.id()) {
        otherEdge = crossing.edge1;
        myPartner = e2Src;
      }

      if (!otherEdge || !myPartner) return;

      const partnerPos = myPartner.position();
      const otherSrcPos = otherEdge.source().position();
      const otherTgtPos = otherEdge.target().position();

      // Calculate which side of the other edge we're on (for future use)
      // const side = (otherTgtPos.x - otherSrcPos.x) * (currentPos.y - otherSrcPos.y) -
      //              (otherTgtPos.y - otherSrcPos.y) * (currentPos.x - otherSrcPos.x);

      // Try moving perpendicular to avoid crossing
      const edgeVec = {
        x: partnerPos.x - currentPos.x,
        y: partnerPos.y - currentPos.y
      };
      const edgeLen = Math.sqrt(edgeVec.x * edgeVec.x + edgeVec.y * edgeVec.y);

      if (edgeLen === 0) return;

      // Perpendicular vector
      const perpVec = {
        x: -edgeVec.y / edgeLen,
        y: edgeVec.x / edgeLen
      };

      // First try mirroring across the other edge
      // Calculate projection of node onto the other edge
      const edgeVecOther = {
        x: otherTgtPos.x - otherSrcPos.x,
        y: otherTgtPos.y - otherSrcPos.y
      };
      const edgeLenOther = Math.sqrt(edgeVecOther.x * edgeVecOther.x + edgeVecOther.y * edgeVecOther.y);

      if (edgeLenOther > 0) {
        const unitEdge = {
          x: edgeVecOther.x / edgeLenOther,
          y: edgeVecOther.y / edgeLenOther
        };

        // Vector from edge start to node
        const toNode = {
          x: currentPos.x - otherSrcPos.x,
          y: currentPos.y - otherSrcPos.y
        };

        // Project onto edge
        const projection = toNode.x * unitEdge.x + toNode.y * unitEdge.y;
        const projPoint = {
          x: otherSrcPos.x + projection * unitEdge.x,
          y: otherSrcPos.y + projection * unitEdge.y
        };

        // Mirror position
        const mirrorPos = {
          x: 2 * projPoint.x - currentPos.x,
          y: 2 * projPoint.y - currentPos.y
        };

        // Test mirror position
        const wouldCrossMirror = edgesCross(mirrorPos, partnerPos, otherSrcPos, otherTgtPos);
        if (!wouldCrossMirror && !wouldCauseNodeCollision(node, mirrorPos)) {
          const originalCrossings = countCrossings(cy);
          node.position(mirrorPos);
          const newCrossings = countCrossings(cy);

          if (newCrossings < originalCrossings) {
            relocations++;
            if (verbose) {
              console.log(`  Relocated ${node.id()} by mirroring across edge to avoid crossing`);
            }
            return; // Success
          } else {
            node.position(currentPos);
          }
        }
      }

      // Try perpendicular movements at different distances
      const distances = [30, 50, 70, 100];

      for (const dist of distances) {
        // Try both directions
        for (const direction of [1, -1]) {
          const testPos = {
            x: currentPos.x + perpVec.x * dist * direction,
            y: currentPos.y + perpVec.y * dist * direction
          };

          // Check if this eliminates the crossing and doesn't cause collisions
          const wouldCross = edgesCross(testPos, partnerPos, otherSrcPos, otherTgtPos);

          if (!wouldCross && !wouldCauseNodeCollision(node, testPos)) {
            // Check if this creates other crossings
            const originalCrossings = countCrossings(cy);
            node.position(testPos);
            const newCrossings = countCrossings(cy);

            if (newCrossings < originalCrossings) {
              relocations++;
              if (verbose) {
                console.log(`  Relocated ${node.id()} perpendicular to avoid crossing`);
              }
              return; // Success, move to next crossing
            } else {
              // Revert
              node.position(currentPos);
            }
          }
        }
      }
    });
  });

  if (verbose && relocations > 0) {
    console.log(`Fix Crossings by Relocation: ${relocations} nodes relocated`);
  }

  return relocations;
}

// Helper function
function countCrossings(cy: any): number {
  let count = 0;
  const edges = cy.edges();

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];

      if (e1.source().id() === e2.source().id() ||
          e1.source().id() === e2.target().id() ||
          e1.target().id() === e2.source().id() ||
          e1.target().id() === e2.target().id()) {
        continue;
      }

      const ccw = (A: any, B: any, C: any) => {
        return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
      };

      const p1 = e1.source().position();
      const p2 = e1.target().position();
      const p3 = e2.source().position();
      const p4 = e2.target().position();

      if (ccw(p1, p3, p4) !== ccw(p2, p3, p4) &&
          ccw(p1, p2, p3) !== ccw(p1, p2, p4)) {
        count++;
      }
    }
  }

  return count;
}