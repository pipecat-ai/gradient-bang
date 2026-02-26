# Starfield - CLAUDE.md

## What this is

A React Three Fiber 3D space visualization library. Renders scenes with ships, ports, nebulae, stars, galaxies, and hyperspace transitions. Consumed by the main Gradient Bang client as `@gradient-bang/starfield`.

## Dev commands

```bash
# From client/starfield/
npm run dev           # Watch mode rebuild (library output)
npm run dev:preview   # Dev server with HMR (uses src/main.tsx)
npm run build         # Full build: tsc -b && vite build
npm run lint          # ESLint
```

Output goes to `dist/` as an ES module with `.d.ts` declarations.

## Architecture

### State (Zustand stores in src root)

| Store | Purpose |
|---|---|
| `useGameStore` | Scene config, game objects, camera targets, performance profile |
| `useAnimationStore` | Animation method registry + state (hyperspace, shake, shockwave, exposure, dim) |
| `useUniformStore` | Mutable Three.js `Uniform` refs for hot-path shader updates (kept outside Immer) |
| `useCallbackStore` | Lifecycle callbacks: `onCreated`, `onReady`, `onSceneChangeStart/End`, `onTargetRest/Clear` |

### Controllers (src/controllers/) - system coordinators

- **SceneController** - Queues scene transitions, debounces rapid changes, manages timing
- **CameraController** - Camera positioning, look-at targeting, FOV animation
- **GameObjectsController** - Positions game objects in 3D space, frustum culling
- **AnimationController** - Registers animation methods, orchestrates transition sequences
- **PostProcessingController** - Manages effects pipeline (sharpening, dithering, grading, exposure, shockwave)

### Data flow

```
Props → useGameStore → Controllers → Visual State
                            ↓
                    useUniformStore → useFrame → Shader updates
```

Scene change: `useSceneChange()` enqueues scene → SceneController sets `isSceneChanging` → AnimationController triggers hyperspace/dim/exposure → new scene applied → callbacks fire.

### Objects (src/objects/) - 3D scene elements

`BaseGameObject` wraps all game objects with fade-in/out lifecycle. Key objects: `Ship`, `Port`, `Planet`, `Galaxy`, `Nebula`, `Sun`, `Tunnel`, `Stars`, `VolumetricClouds`, `Dust`, `Fog`, `LensFlare`.

### Animations (src/animations/)

Spring-based via `useAnimationSpring`. Each animation exposes a `start()` method registered in AnimationStore. Key animations: `hyperspaceAnim`, `shakeAnim`, `exposureAnim`, `dimAnim`, `sceneChangeAnim`, `shockwaveAnim`, `gameObjectFadeAnim`.

### Shaders (src/shaders/)

Custom GLSL: galaxy FBM noise, nebula volume, planet shadow, sun corona, tunnel warp. Uniforms managed through `useUniformStore`.

### Effects (src/fx/)

Post-processing stack built on `postprocessing` library. `PostProcessingManager` singleton created in controller, syncs config changes.

## Public API (src/index.ts)

```ts
export { Starfield }              // Main component
export { generateRandomScene }     // Scene config generator
export { useSceneChange }          // Queue scene transitions
export { useStarfieldEvent }       // Runtime: animateImpact, addGameObject, removeGameObject
export type { StarfieldProps, ... } // Types
```

## Key conventions

- `@/` path alias for absolute imports from `src/`
- One component per file, PascalCase components, camelCase functions
- Stores suffixed `Store`, animations suffixed `Anim`
- Render layers: DEFAULT, SKYBOX, BACKGROUND, FOREGROUND, GAMEOBJECTS, OVERLAY
- 8 color palettes in `colors.ts` (celestialBlue, deepSpace, nebulaDust, etc.)
- 4 performance profiles in `profiles.ts` (low/mid/high/extreme + auto-detect via GPU tier)
- Heavy `React.memo` with custom comparators for render optimization

## Important patterns

- **Uniform store is intentionally mutable** - don't wrap in Immer. Three.js uniforms need direct mutation on every frame.
- **Scene queue is debounced** - rapid scene changes collapse to the last one.
- **Game object positioning** uses random sphere-shell placement with minimum-distance constraints and camera frustum awareness.
- **No test files** - tested via Storybook (`client/app/src/stories/starfield.stories.tsx`) and manual dev preview.
