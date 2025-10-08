# Warp Queue System Documentation

## Overview

The warp queue system manages scene transitions in the starfield, coordinating warp animations, queue processing, and cooldowns to ensure smooth visual transitions and prevent animation spam.

---

## Core Components

### 1. **Warp Animation Phases**

The warp animation progresses through these phases:

- **CHARGING** (0-1s) - Build up effect
- **BUILDUP** (1-3s) - Accelerate
- **CLIMAX** (3-4s) - Peak intensity
- **FLASH** (4-4.5s) - White flash, scene loads in background
- **COOLDOWN** (4.5-5s) - Wind down, transition complete

### 2. **Queue System**

- **Queue**: FIFO array storing `WarpOptions` for pending scene changes
- **Processing**: Sequential loading with configurable delays
- **Shake State**: Visual feedback during queue processing

### 3. **Cooldown Timer**

- **Purpose**: Prevent animation spam
- **Default Duration**: 15 seconds
- **Behavior**: Forces subsequent warps to queue instead of animating

---

## API: `warpToSector(options)`

### Parameters

```typescript
interface WarpOptions {
  id?: string;                              // Sector/scene ID
  name?: string;                            // Sector name
  sceneConfig?: Partial<StarfieldSceneConfig>; // Scene variant config
  gameObjects?: GameObjectBaseConfig[];     // Objects to place
  bypassAnimation?: boolean;                // Skip warp animation (default: false)
  bypassFlash?: boolean;                    // Skip flash transition (default: false)
}
```

### Decision Logic

```
1. Check if currently warping → Queue
2. Check if processing queue → Queue
3. Check if cooldown active → Queue (and start processing)
4. Otherwise → Play animation
```

---

## Timeline Examples

### Example 1: Single Warp (No Queue)

```
T=0s:   warpToSector({ id: "sector1" })
        → state: "idle", queue: empty, cooldown: inactive
        → onWarpStart() ✓
        → Start warp animation
        
T=4s:   FLASH phase begins
        → Scene loads in background
        → onSceneIsLoading()
        
T=4.2s: Scene loaded
        → onSceneReady()
        
T=5s:   COOLDOWN phase completes
        → state: "idle"
        → Cooldown timer starts (15s)
        → onWarpComplete(0) ✓
        → No queue to process
```

---

### Example 2: Rapid Fire During Animation (Queue)

```
T=0s:   warpToSector({ id: "sector1" })
        → Start animation
        → onWarpStart() ✓

T=1s:   warpToSector({ id: "sector2" })
        → state: "warping" → QUEUE
        → onWarpQueue(1) ✓
        → Queue: ["sector2"]

T=2s:   warpToSector({ id: "sector3" })
        → state: "warping" → QUEUE
        → onWarpQueue(2) ✓
        → Queue: ["sector2", "sector3"]

T=3s:   warpToSector({ id: "sector4" })
        → state: "warping" → QUEUE
        → onWarpQueue(3) ✓
        → Queue: ["sector2", "sector3", "sector4"]

T=5s:   Animation completes (COOLDOWN phase)
        → Queue has 3 items
        → state: "shake" (queue shake)
        → onWarpComplete(3) ✓
        → Cooldown timer starts (15s)
        → Start processing queue

T=5.5s: Process sector2 (after queueProcessingDelaySec)
        → Load directly (no animation)
        → state: "shake" (continues)
        → onSceneIsLoading()
        → onSceneReady()
        → onWarpComplete(2) ✓

T=6.0s: Process sector3
        → Load directly
        → state: "shake"
        → onWarpComplete(1) ✓

T=6.5s: Process sector4
        → Load directly
        → state: "shake"
        → onWarpComplete(0) ✓
        → state: "idle" (shake ends)
```

---

### Example 3: Call During Cooldown

```
T=0s:   warpToSector({ id: "sector1" })
        → Start animation
        → onWarpStart() ✓

T=5s:   Animation completes
        → Cooldown starts (expires at T=20s)
        → onWarpComplete(0) ✓

T=6s:   warpToSector({ id: "sector2" })
        → Cooldown active → QUEUE
        → onWarpQueue(1) ✓
        → Start queue processing immediately

T=6.5s: Process sector2
        → Load directly (no animation)
        → state: "shake"
        → onWarpComplete(0) ✓
        → state: "idle"

T=20s:  Cooldown expires
        → Can animate again

T=21s:  warpToSector({ id: "sector3" })
        → Cooldown expired → ANIMATE!
        → onWarpStart() ✓
```

---

### Example 4: Bypass Animation (Direct Loading)

```
T=0s:   warpToSector({ id: "sector1", bypassAnimation: true })
        → Load directly without animation
        → onSceneIsLoading()
        → onSceneReady()
        → onWarpComplete(0) ✓
        → No cooldown (because no animation played)

T=0.5s: warpToSector({ id: "sector2", bypassAnimation: true })
        → Load directly again
        → onWarpComplete(0) ✓
        → Can call repeatedly without queueing
```

---

### Example 5: Bypass Flash (Fast Queue Processing)

```
T=0s:   warpToSector({ id: "sector1" })
        → Start animation

T=1s:   warpToSector({ id: "sector2", bypassFlash: true })
        → Queued

T=2s:   warpToSector({ id: "sector3", bypassFlash: true })
        → Queued

T=5s:   Animation completes
        → Start processing queue

T=5.5s: Process sector2 (bypassFlash: true)
        → Load instantly, no flash transition
        → Faster scene change

T=6.0s: Process sector3 (bypassFlash: true)
        → Load instantly, no flash
```

---

## Callbacks

### Callback Reference

```typescript
interface StarfieldCallbacks {
  onWarpStart?: () => void;
  onWarpComplete?: (queueRemainingCount: number) => void;
  onWarpCancel?: () => void;
  onWarpQueue?: (queueLength: number) => void;
  onSceneIsLoading?: () => void;
  onSceneReady?: (isInitialRender: boolean, sceneId: string | null) => void;
}
```

### Callback Flow

**With Animation:**
```
onWarpStart()
  → (animation plays)
  → onWarpQueue(N) [if queue items exist]
  → onSceneIsLoading()
  → onSceneReady()
  → onWarpComplete(queueRemainingCount)
```

**Direct Loading (bypass animation):**
```
onSceneIsLoading()
  → onSceneReady()
  → onWarpComplete(queueRemainingCount)
```

**Queue Processing:**
```
onWarpQueue(N) [when item added to queue]
  → (for each queued item)
  → onSceneIsLoading()
  → onSceneReady()
  → onWarpComplete(queueRemainingCount)
```

---

## Configuration

### Timing Constants

```typescript
// In GalaxyStarfieldConfig
{
  warpDurationSec: 5,           // Warp animation duration
  warpCooldownSec: 15,          // Cooldown before next animation
  queueProcessingDelaySec: 0.5, // Delay between queued items
}
```

### Scene Ready Detection

```typescript
SCENE_SETTLE_DURATION: 150ms    // Wait time after reloadConfig
MIN_FLASH_HOLD_TIME: 300ms      // Minimum flash display time
MAX_FLASH_HOLD_TIME: 5000ms     // Maximum wait for scene loading
```

---

## Shake State During Queue

### Purpose

Visual feedback to indicate queue processing is active.

### Behavior

1. **Flag Set**: `_shouldShakeDuringQueue = true` when queue has items
2. **Shake Starts**: State changes to "shake" when animation completes
3. **Shake Continues**: Persists through all queue item processing
4. **Shake Ends**: State returns to "idle" when queue empties

### Manual Control

```typescript
starfield.startShake();  // If warping, queues shake for after animation
starfield.stopShake();   // Clears shake flag and returns to idle
```

---

## Public API Methods

### Queue Management

```typescript
starfield.warpToSector(options)      // Main warp/queue method
starfield.getWarpQueueLength()       // Returns queue size
starfield.clearWarpQueue()           // Clears all queued items
starfield.isProcessingWarpQueue      // Getter: is queue being processed?
```

### Cooldown Management

```typescript
starfield.isWarpCooldownActive       // Getter: is cooldown active?
starfield.clearWarpCooldown()        // Manually clear cooldown
```

### Animation Control

```typescript
starfield.startShake()               // Start shake (or queue it)
starfield.stopShake()                // Stop shake and clear flag
starfield.setIdle()                  // Return to idle state
```

---

## Edge Cases & Special Behavior

### 1. Same Sector ID

```typescript
warpToSector({ id: "sector1" })
warpToSector({ id: "sector1" })  // Ignored (already at sector1)
```

### 2. First Scene Load

```typescript
// Very first call, no current scene
warpToSector({ id: "sector1" })
→ Loads directly (no animation, because !this._currentSceneId)
```

### 3. Queue Cleared Mid-Processing

```typescript
warpToSector({ id: "sector1" })  // Animation starts
warpToSector({ id: "sector2" })  // Queued
warpToSector({ id: "sector3" })  // Queued

// During animation:
starfield.clearWarpQueue()
→ Queue cleared
→ Shake flag cleared
→ Returns to idle when animation completes
→ No items processed
```

### 4. Multiple Calls to Same Scene During Warp

```typescript
warpToSector({ id: "sector1" })  // Animation starts
warpToSector({ id: "sector1" })  // Ignored (same ID)
```

---

## Testing Scenarios

### Rapid Fire Test

**Purpose**: Test queue building during animation

```typescript
warpToSector({ id: "sector1" });
setTimeout(() => warpToSector({ id: "sector2" }), 500);
setTimeout(() => warpToSector({ id: "sector3" }), 1000);
setTimeout(() => warpToSector({ id: "sector4" }), 1500);

// Expected: Animation plays for sector1, 
// then sectors 2-4 process in queue with shake
```

### Cooldown Test

**Purpose**: Test cooldown preventing animation

```typescript
warpToSector({ id: "sector1" });
setTimeout(() => warpToSector({ id: "sector2" }), 6000);

// Expected: sector1 animates, 
// sector2 queues (cooldown active), 
// processes without animation
```

### Full Cycle Test

**Purpose**: Test complete flow from animation → queue → cooldown expire

```typescript
warpToSector({ id: "sector1" });
setTimeout(() => {
  warpToSector({ id: "sector2" });
  warpToSector({ id: "sector3" });
}, 1000);
setTimeout(() => warpToSector({ id: "sector4" }), 21000);

// Expected: 
// - sector1 animates
// - sectors 2-3 queue and process with shake
// - 15s cooldown elapses
// - sector4 animates (cooldown expired)
```

---

## Best Practices

### 1. Use Callbacks for UI Updates

```typescript
const callbacks = {
  onWarpQueue: (queueLength) => {
    // Show "X jumps queued" indicator
  },
  onWarpComplete: (remaining) => {
    if (remaining === 0) {
      // Hide queue indicator
    }
  }
};
```

### 2. Clear State When Needed

```typescript
// Before starting a new test scenario:
starfield.clearWarpQueue();
starfield.clearWarpCooldown();
```

### 3. Bypass Animation for Initial Load

```typescript
// First scene, no visual needed:
starfield.warpToSector({
  id: initialSectorId,
  bypassAnimation: true,
  bypassFlash: true
});
```

### 4. Use bypassFlash for Fast Queue Processing

```typescript
// For rapid sequential moves:
warpToSector({ id: "sector1" });  // Animate first
warpToSector({ id: "sector2", bypassFlash: true });  // Fast queue
warpToSector({ id: "sector3", bypassFlash: true });  // Fast queue
```

---

## Architecture Notes

### Config Locking

When a warp animation starts, the scene config is "locked" in `_lockedWarpConfig`. Subsequent calls during the animation won't replace this config - they're queued instead. This ensures the animation plays out for the intended destination.

### Queue vs Direct Loading Decision

The system uses this hierarchy:
1. **Warping?** → Queue
2. **Processing queue?** → Queue
3. **Cooldown active?** → Queue and start processing
4. **Otherwise** → Play animation

### Shake Flag Pattern

The `_shouldShakeDuringQueue` flag is set early (during FLASH phase or when queue processing starts) but the actual state change happens later (COOLDOWN phase or first queue item). This allows the system to prepare for shake without interfering with ongoing animations.

---

## Common Issues

### Issue: Animation not playing

**Cause**: Cooldown timer still active from previous warp

**Solution**: 
```typescript
starfield.clearWarpCooldown();
// or wait for cooldown to expire
```

### Issue: Queue items not processing

**Cause**: Queue processing flag stuck

**Solution**:
```typescript
starfield.clearWarpQueue();
// Try warp again
```

### Issue: Shake won't stop

**Cause**: Shake flag not cleared

**Solution**:
```typescript
starfield.stopShake();
```

---

## Future Enhancements

Potential improvements to consider:

1. **Priority Queue**: Allow high-priority warps to skip the queue
2. **Queue Callbacks**: Individual callbacks for each queue item
3. **Cancellable Warps**: Cancel specific queued items by ID
4. **Queue Limits**: Maximum queue size with overflow handling
5. **Smart Cooldown**: Shorter cooldown for short-distance warps

---

## Related Files

- `client/src/fx/starfield/main.ts` - Main implementation
- `client/src/fx/starfield/constants.ts` - Configuration defaults
- `client/src/stories/starfield.stories.tsx` - Test scenarios
- `client/src/components/StarField.tsx` - React component wrapper

