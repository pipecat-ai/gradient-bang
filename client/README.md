# Gradient Bang Client Packages

<img width="640" src="image.png" style="margin-bottom:20px;" />

> [!WARNING]
> **Client is in active development and does not yet support smaller screens / mobile viewports.**

> [!WARNING]
> **3D FX / starfield is very resource intensive!** A refactor will be merged soon which dramatically reduces overhead. If your CPU is throttling or computer fans are at full spin, please disable the Starfield in settings (or set `bypassStarfield` in `settings.json`).


## Quickstart

> [!NOTE]
> The game client looks best with the beautiful [TX-02 Berkeley Mono](https://usgraphics.com/products/berkeley-mono) typeface. We recommend you grab a license and place it in `app/src/assets/fonts/tx-02.woff2`

```bash
# Install and configure
pnpm i
cp app/env.example app/.env

# Dev mode (with hot reload & devtools)
pnpm run dev

# Preview mode (optimized, production-like)
pnpm run preview
```

> [!NOTE]
> **Prerequisites:** The game client requires the local Supabase stack (edge functions) and the Pipecat bot to be running. See the root README for setup instructions.

### Dev vs Preview

- **Dev mode**: Hot reload, Leva devtools, no PWA, unoptimized profiles
- **Preview mode**: Production build, asset caching enabled, optimized

Leva dev tools provide triggers for mock events / local store mutations. Disable by setting `useDevTools: false` in `app/src/settings.json` (removes Leva from bundle).

## Transport Options

The client uses WebRTC to connect to the Pipecat bot. Default is **SmallWebRTC** (recommended for local dev).

### SmallWebRTC (default)

```bash
# Start bot (from repo root)
uv run pipecat_server/bot.py
```

> [!NOTE]
> **Troubleshooting CORS errors:** Try connecting to `http://0.0.0.0:5173` or modify the proxy target in `app/vite.config.ts`.

### Daily (alternative)

Requires a Daily API key. First install the transport package:

```bash
pnpm i @pipecat-ai/daily-transport
```

Then configure via environment variable:

```bash
# client/app/.env
VITE_PIPECAT_TRANSPORT=daily
```

Or via query string: `http://localhost:5173/?transport=daily`

Start the bot with Daily:

```bash
# Requires DAILY_API_KEY in environment
uv run pipecat_server/bot.py -t daily
```

See [transport guide](https://docs.pipecat.ai/guides/learn/transports) for more details.

## Development Guide

### Packages

#### `/app`

Browser game client (Vite, React, TypeScript)

- Fetches data from Supabase edge functions / REST (leaderboard, etc)
- Connects via WebRTC to the Pipecat Bot for voice-driven gameplay
- Implements the Pipecat [Voice UI Kit](https://github.com/pipecat-ai/voice-ui-kit)
- Handles and syncs client state via websocket data messages
- State managed via [Zustand](https://zustand-demo.pmnd.rs/)

#### `/starfield`

3D (ThreeJS) space graphics used by the game client. Bundled via Rollup.

> [!NOTE]
> This package is not published to NPM, so you will need to build it first in order to use it in game client app. Built automatically by Turbo workflow.

### Player Settings / Preferences

Settings made at runtime via the client are retained in local storage. Overrides can be hardcoded in `app/src/settings.json` which take priority over any locally stored settings, and replace defaults in the store's setting slice.

The following can not be changed at runtime:

```ts
    // Audio - SFX / Music / Voice
    disabledAmbience: false
    disabledSoundFX: false
    disableMusic: false
    disableRemoteAudio: false
    ambienceVolume: 0.5
    musicVolume: 0.2
    soundFXVolume: 0.5
    remoteAudioVolume: 1 // Bot voice volume

    // User device control
    enableMic: false // disable user mic access (for text mode)
    startMuted: false // join game with mic muted

    // Performance
    qualityPreset: "auto" // "text" | "low" | "high" | "auto"
    // Note: "text" and "low" enables prefers-reduced-motion

    // 3D / ThreeJS Starfield (requires high performance device)
    renderStarfield: true // disable entirely
    fxBypassFlash: false // reduces flash effects (e.g. during warp)
    fxBypassAnimation: false // no warp animation

    saveSettings: true // disable local storage
    bypassAssetCache: false // runtime asset preloading / caching

```

> [!NOTE]
> `settings.json` overrides apply when building too.

### Storybook

The `app` project uses [Ladle](https://ladle.dev) as a sandbox for testing components in isolation.

```bash
pnpm run dev:stories

# or run both dev server and stories
pnpm run dev:all
```

Stories can optionally run in a connected state, configured via Story meta flags. All stories are mounted within the `GameContext` and `PipecatAppBase`:

```ts
MyStory.meta = {
  disconnectedStory: false, // Show connect to bot UI
  enableMic: false, // Enable or disable user mic input
  disableAudioOutput: true, // Muted bot TTS output
  messages: [], // Array of action objects for quick dispatch
};
```

### Tests

TBD

### Asset Caching / PWA

Core game assets are preloaded and cached when a user first loads the client or cache is stale. This ensures smooth gameplay and prevents render blocking as players hop between sectors or trigger lazy-loaded UI elements.

- Assets to preload are specified in `app/src/assets/index.ts`
- Vite generates a manifest and PWA service worker
- Asset filenames are hashed

PWA caching is disabled when running in dev. You can also bypass runtime preloading by setting `bypassAssetCache` in `settings.json`.

## Architecture Reference

### Entry Point

**`main.tsx`** — Application entry point. Applies any initial settings or query string overrides. Wraps app in `PipecatAppBase` and the `GameContext`.

### Directory Structure

| Directory | Description |
|-----------|-------------|
| `/assets` | Bundled game assets and preload / cache manifest |
| `/components` | React components |
| `/components/views` | Game state 'pages', e.g. title screen view, join view, game view |
| `/components/dialogs` | Modal popover windows |
| `/components/hud` | Game view UI elements rendered at the top level and always on-screen during gameplay |
| `/components/panels` | Data tables and re-usable info composites. The Pipecat UI agent can reference these by their unique ID to build dynamic, contextual screens |
| `/components/primitives` | Headless UI components / ShadCN |
| `/components/screens` | Primary UI composites that the Pipecat UI Agent can request to show. Displayed one at a time, e.g. ship / player info, universe map, trading info, corporation details etc. |
| `/components/toasts` | Dismissible contextual notifications overlaid on the HUD |
| `/css` | Tailwind 4 theme and custom utilities. Note: custom `cva` / Tailwind merge script found in `utils/tailwind.ts` |
| `/fx` | Standalone / wrapper effect components. Often created as singleton instances (e.g. mini map, swooshy lines, glitch text effect etc). These are self-contained and don't use other components |
| `/hooks` | Functional React hooks used app-wide |
| `/store` | Zustand store and slices |
| `/stories` | Ladle / Storybook stories for testing features in isolation. Note: excluded from build |
| `/types` | TypeScript typings and interfaces. Primary game object typings are set globally (`global.d.ts`) |
| `/utils` | Misc helpers and utils. Note: `tailwind.ts` replaces the typical `cn/utils` file created by ShadCN |
| `/mocks` | Mock data objects and test stubs |

### Key Files

**`GameContext.tsx`** — Primary context for managing game state, initialization flow and handling Pipecat connection. All incoming server data messages are handled here (for now!)

**`icons.ts`** — Exported references to icons within our chosen library [Phosphor Icons](https://phosphoricons.com/). Referencing here makes it easier to modify app-wide changes for game-centric iconography (such as cargo resources, HUD elements etc.)

**To be deprecated:**

 **`GameInstanceManager.tsx`** — Singleton class that manages lifecycle of core game elements, such as the Starfield. Subscribes to any changes in the settings store and constructs / destroys accordingly. Soon to be removed!

## Deployment

`app` depends the `starfield` package. If you are building as part of a CI workflow outside of the workspace, you must specify a location to this package in `app/package.json`. 

The Starfield package is not publicly distributed / available via npm.
