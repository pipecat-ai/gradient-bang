# Gradient Bang Client Packages

<img width="640" src="image.png" style="margin-bottom:20px;" />

🚧 **Client is in active development and does not yet support smaller screens / mobile viewports.**

🚧 **3D FX / starfield is mid-refactor. The current version is highly resource intensive! If your CPU is throttling or computer fans are at full spin, please disable the Starfield in settings (or set `bypassStarfield` in `settings.json`).**

## Quickstart

*Note: The game client looks best with the beautiful [TX-02 Berkeley Mono](https://usgraphics.com/products/berkeley-mono) typeface. We recommend you grab a license and place it in `app/src/assets/fonts/tx-02.woff2`*

#### Point client at server and bot URL (if not using default):

```bash
cp app/env.example app/.env
```

#### Build and run:

```bash 
pnpm i
pnpm run preview

# ...or for dev

pnpm run dev
```

#### Dev vs Preview

Notable differences when in dev:

- Supports hot reloading
- Overlays [Leva](https://github.com/pmndrs/leva) UI devtools
- Disables the PWA service worker / asset caching [see here](#asset-caching--pwa)
- Uses unoptimized device profiles

The DevTools controls provide triggers for mock events / local store mutations If you'd like to hide the panel, disable `useDevTools` in `app/src/settings.json`. This removes Leva entirely from the bundle.


## Joining your game world

The game client is designed around voice input. Unlike the Python TUI, you must run both the `game-server` and `pipecat-server` apps. 

Assuming you have already run the universe-bang script and created a player, start the server and bot (from root):

```shell
uv run game-server/server.py
uv run pipecat_server/bot.py 
```

Take note of the URLs shown when starting each process, and update `client/app/.env` if they differ from the defaults.

Pipecat and client default to using [SmallWebRTC](https://docs.pipecat.ai/server/services/transport/small-webrtc), recommended for local development.


### Using Daily

You can use [Daily](https://www.daily.co) instead of SmallWebRTC by passing a query string to your client URL:

*Note: the Daily transport client package is not installed by default. Please run `pnpm i @pipecat-ai/daily-transport`*

```shell
https://localhost:5173/?transport=daily
```

... or by setting the transport env var:

```shell
# client/app/.env
VITE_PIPECAT_TRANSPORT=daily
```

Start the Pipecat bot process specifying Daily:

```shell
uv run pipecat_server/bot.py -t daily
```

**Note: the bot will require a DAILY_API_KEY set in the server environment.**

Refer to [this guide](https://docs.pipecat.ai/guides/learn/transports) and [this](https://www.daily.co/blog/you-dont-need-a-webrtc-server-for-your-voice-agents/) blog post for more information about transports and their differences.

### SmallWebRTC CORS errors

Depending on your local setup, you may see CORs errors in the web console and fail to connect. You may need to connect over `0.0.0.0` or modify the proxy config in [vite.config.ts](vite.config.ts) in the app root.

## Hacking on the client app

### Packages

#### `/app`

Browser game client (Vite, React, TypeScript)

- Fetches data from the game server over HTTP (leaderboard, etc)
- Connects via WebRTC to the Pipecat Bot for voice-driven gameplay
- Implements the Pipecat [Voice UI Kit](https://github.com/pipecat-ai/voice-ui-kit)
- Handles and syncs client state via websocket data messages
- State managed via [Zustand](https://zustand-demo.pmnd.rs/)

#### `/starfield`

3D (ThreeJS) space graphics used by the game client. Bundled via Rollup.

**Note: This package is not published to NPM, so you will need to build it first in order to use it in game client app. Built automatically by Turbo workflow.**


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

**Note: `settings.json` overrides apply when building too.**

### Storybook

The `app` project uses [Ladle](https://ladle.dev) as a sandbox for testing various components and features in isolation. Run it with:

```bash
pnpm run dev:stories

# or if you want both

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

### Asset caching / PWA

To ensure a smooth and immersive space adventure, core game assets are preloaded and cached when a user first loads the client or cache is stale.

Gameplay is fast! Players often hop between multiple sectors in succession, or render lazy loaded UI elements in response to the UI Agent.

Preloading avoids runtime suspense / render blocking to minimize the client falling out of sync with the server (especially in low bandwidth scenarios.)

- Assets to preload are specified in `app/src/assets/index.ts`
- Vite generates a manifest and PWA service worker
- Asset filenames are hashed

PWA caching is disabled when running in dev. You can also bypass runtime preloading and showing the preload view by setting `bypassAssetCache` in `settings.json`.


## Hacking on the client

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

**`DevTools.tsx`** - Conditionally rendered (dev only) LevaUI wrapper

**`icons.ts`** — Exported references to icons within our chosen library [Phosphor Icons](https://phosphoricons.com/). Referencing here makes it easier to modify app-wide changes for game-centric iconography (such as cargo resources, HUD elements etc.)

**To be deprecated:**

 **`GameInstanceManager.tsx`** — Singleton class that manages lifecycle of core game elements, such as the Starfield. Subscribes to any changes in the settings store and constructs / destroys accordingly. Soon to be removed!

## Deployment

`app` depends the `starfield` package. If you are building as part of a CI workflow outside of the workspace, you must specify a location to this package in `app/package.json`. 

The Starfield package is not publicly distributed / available via npm.
