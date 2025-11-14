# Gradient Bang Client Packages

<img width="640" src="image.png" style="margin-bottom:20px;" />

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

Assuming you have already run the universe bang script and have created a player, ensure both these follow processes are live (from root):

```shell
uv run game-server/server.py
uv run pipecat_server/bot.py 
```

Take note of the URLs shown when starting each process, and update `client/app/.env` if they differ from the defaults.

The app defaults to using [SmallWebRTC](https://docs.pipecat.ai/server/services/transport/small-webrtc) as a transport for Pipecat, which is recommended for local development.


### Using Daily

You can connect use [Daily](https://www.daily.co) instead of SmallWebRTC by passing a query string to your client URL:

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

Depending on your local setup, you may see CORs errors in the web console and fail to connect.

Address this by running the processes on `0.0.0.0` or modifying the proxy in the [vite.config.ts](vite.config.ts) file in the app root.

## Development

### Packages

#### `/app`

Web game client (Vite, React, TypeScript)

- Fetches data from the Game Server for HTTP requests (leaderboard, etc)
- Connects via WebRTC to the Pipecat Bot for voice
- Implements the Pipecat [Voice UI Kit](https://github.com/pipecat-ai/voice-ui-kit)
- State managed via [Zustand](https://zustand-demo.pmnd.rs/)
- Lazy loads relevant libraries (such as transports, larger dependency chunks, and Leva in dev)

#### `/starfield`

ThreeJS sector visualizer used by the game client. Bundled as a package via rollup.

Note: This package is not published to NPM, so you will need to build it first in order to use it in game client app.


### Storybook

The `app` project uses Ladle as a sandbox for testing various components and features. It can be run with:

```bash
pnpm run dev:stories

# or if you want both

pnpm run dev:all
```

### Tests

TBD

### Asset caching / PWA

To ensure a smooth and immersive space experience, core game assets are preloaded and cached when a user first launches the client. 

- Assets to preload are specified in `app/src/assets/index.ts`
- Vite creates a manifest and PWA service worker on build
- All asset file names get a unique hash on build

Asset caching is disabled when running in dev. You can bypass showing the loading screen entirely by setting `bypassAssetCache` in `settings.json`.


### Hacking on the client

`main.tsx`
- Entry point
- Applies any initial settings or query string overrides
- Wraps app in `PipecatAppBase` and the `GameContext`

- `/assets` - Bundled game assets and preload / cache manifest
- `/components` - React components
    - `/views` - Game state 'pages', e.g. title screen view, join view, game view.
    - `/dialogs` - Modal popover windows
    - `/hud` - Game view UI elements rendered at the top level and always on-screen during gameplay
    - `/panels` - Data tables and re-usable info composites. The Pipecat UI agent can reference these by their unique ID to build dynamic, contextual screens.
    - `/primitives` - Headless UI components / ShadCN
    - `/screens` - Primary UI composites that the Pipecat UI Agent can request to show. Displayed one at a time, e.g. ship / player info, universe map, trading info, corporation details etc.
    - `/toasts` - Dismissible contextual notifications overlaid on the HUD
- `/css` - Tailwind 4 theme and custom utilities. Note: custom `cva` / Tailwind merge script found in `utils/tailwind.ts`
- `/fx` - Standalone / wrapper effect components. Often created as singleton instances (e.g. mini map, swooshy lines, glitch text effect etc) These are self-contained and don't use other components
- `/hooks` - functional React hooks used app-wide
- `/store` - Zustand store and slices
- `/stories` - Ladle / Storybook stories for testing features in isolation. Note: excluded from build.
- `/types` - TypeScript typings and interfaces. Primary game object typings are set globally (`global.d.ts`)
- `/utils` - Misc helpers and utils. Note: `tailwind.ts` replaces the typical `cn/utils` file created by ShadCN.

`GameContext.tsx` 

Higher-order context for managing game state, instantiating manager instances and handling Pipecat connection. All incoming server data messages are handled here (for now!)

`GameInstanceManager.tsx`

Singleton instance manager that manages construction and lifecycle of key game elements, such as the Starfield. Subscribes to any changes to the settings store and constructs / destroys imperative objects accordingly.

Note: as a pattern, we aim to remain as 'React' as possible vs. creating components that are accessed via imperative APIs. The starfield is mid-refactor to leverage Drei / Fiber; this manager will likely be retired soon.

`icons.ts` 

Exported references to icons within our chosen library [Phosphor Icons](https://phosphoricons.com/). Referencing here makes it easier to modify app-wide changes for game-centric iconography (such as cargo resources, HUD elements etc.)


## Deployment

`app` depends on a developer-built `starfield` package. If you are building as part of a CI workflow, you must specify a location to this package in `app/package.json`. 

The Starfield package is not publicly distributed / available via npm.