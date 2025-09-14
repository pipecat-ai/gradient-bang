#!/usr/bin/env node

/**
 * Test runner for graph layout functions using the GraphLayout module
 * Validates that the layout algorithm produces 0 crossings and 0 collisions
 * for all saved test cases.
 */

const fs = require('fs');

// Load the GraphLayout module - now fully encapsulated
const GraphLayout = require('./graph_layout.js');

async function runLayoutWithRetries(nodes, centerId, verbose = false) {
  // Try up to 3 times to get a perfect layout
  const maxRetries = 3;
  let lastResult = null;

  for (let retry = 0; retry < maxRetries; retry++) {
    if (verbose && retry > 0) {
      console.log(`\n  Retry ${retry}...`);
    }

    // Use GraphLayout.runLayout with full optimization
    lastResult = await GraphLayout.runLayout(nodes, centerId, {
      verbose: verbose,
      minNodeDist: 4,
      nodeRepulsion: 16000,
      maxOptimizeAttempts: 20
    });

    // Return immediately if perfect
    if (lastResult.crossings === 0 && lastResult.collisions === 0) {
      return lastResult;
    }

    // Continue to next retry if not perfect
    if (verbose) {
      console.log(`  Result: ${lastResult.crossings} crossings, ${lastResult.collisions} collisions`);
    }
  }

  // Return the last attempt's result (don't run a 4th time)
  return lastResult;
}

async function runTests() {
  console.log('=' .repeat(60));
  console.log('GRAPH LAYOUT TEST SUITE');
  console.log('=' .repeat(60));

  // Load test data
  let testData;
  try {
    const fileContent = fs.readFileSync('layout_test_data.jsonl', 'utf8');
    testData = fileContent
      .split('\n')
      .filter(line => line.trim())
      .map((line, idx) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.error(`Error parsing line ${idx + 1}: ${e.message}`);
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    console.error(`Failed to load test data: ${e.message}`);
    process.exit(1);
  }

  console.log(`\nLoaded ${testData.length} test cases\n`);

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < testData.length; i++) {
    const testCase = testData[i];
    const testNum = i + 1;

    process.stdout.write(`Test ${testNum}/${testData.length}: Center ${testCase.center_sector}... `);

    try {
      // No special handling for any sectors - treat all equally
      const verbose = false;

      // Run layout with up to 3 retries
      const result = await runLayoutWithRetries(testCase.node_list, testCase.center_sector, verbose);

      if (result.crossings === 0 && result.collisions === 0) {
        console.log('✓ PASSED');
        passed++;
      } else {
        console.log(`✗ FAILED (${result.crossings} crossings, ${result.collisions} collisions)`);
        failed++;
      }
    } catch (e) {
      console.log(`✗ ERROR: ${e.message}`);
      failed++;
    }
  }

  console.log('\n' + '=' .repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('ALL TESTS PASSED ✓');
  } else {
    console.log('SOME TESTS FAILED ✗');
  }
  console.log('=' .repeat(60));

  process.exit(failed === 0 ? 0 : 1);
}

// Run tests
runTests().catch(console.error);