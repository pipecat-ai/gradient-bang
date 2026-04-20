# Gradient Bang Client

Monorepo workspace containing the game client and 3D starfield library, built with pnpm and Turbo.

```
client/
├── app/         # Web client (React, Zustand, Tailwind CSS)
├── starfield/   # 3D space visualization library (Three.js, React Three Fiber)
├── turbo.json   # Build pipeline config
└── pnpm-workspace.yaml
```

## Quickstart

> [!NOTE]
> The game client looks best with the [TX-02 Berkeley Mono](https://usgraphics.com/products/berkeley-mono) typeface. Grab a license and place it in `app/src/assets/fonts/tx-02.woff2`.

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
> The game client requires the local Supabase stack (edge functions) and the Pipecat bot to be running. See the root README for setup instructions.

### Dev vs Preview

- **Dev mode**: Hot reload, Leva devtools, no PWA
- **Preview mode**: Production build, asset caching, PWA enabled

## Packages

### `/app`

Browser game client built with Vite, React 19, and TypeScript.

- Connects via WebRTC to the Pipecat bot for voice-driven gameplay
- Fetches data from Supabase edge functions
- State managed via Zustand
- UI built with Radix primitives and Tailwind CSS 4
- Animation via React Spring and Motion

### `/starfield`

3D space graphics library using Three.js and React Three Fiber. Bundled as an ES module consumed by the app as a workspace dependency (not published to npm).

- Custom GLSL shaders (galaxy, nebula, sun, tunnel, planets)
- Post-processing pipeline (dithering, exposure, color grading, shockwave)
- Performance profiles (low/mid/high/extreme) with GPU auto-detection
- Frame-on-demand rendering

## Environment Variables

Configure in `app/.env` (see `app/env.example`). All are optional.

| Variable                           | Default                               | Description                                                                               |
| ---------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `VITE_SERVER_URL`                  | `http://localhost:54321/functions/v1` | Supabase edge functions URL                                                               |
| `VITE_PIPECAT_TRANSPORT`           | `smallwebrtc`                         | WebRTC transport (`smallwebrtc` or `daily`). Also settable via `?transport=` query string |
| `VITE_BOT_URL`                     | unset (Ladle: `http://localhost:7860`) | Dev-only. Pipecat bot base URL (no trailing `/start`). When set in dev builds, the client bypasses the Supabase `/start` edge-function shim and talks to a local bot directly. Ignored in production builds. |
| `VITE_MAINTENANCE_MODE`            | —                                     | Set to any truthy value to show maintenance screen                                        |
| `VITE_SERVER_LEADERBOARD_ENDPOINT` | `/leaderboard_resources`              | Leaderboard edge function path                                                            |
| `VITE_APP_VERSION`                 | from `package.json`                   | Injected at build time via `vite.config.ts` — not user-set                                |

## Development

### Storybook

Component sandbox using [Ladle](https://ladle.dev):

```bash
pnpm run dev:stories

# or run both dev server and stories
pnpm run dev:all
```

### Settings

Runtime settings are stored in local storage. Hardcoded overrides can be set in `app/src/settings.json` (takes priority over local storage). Covers audio, performance presets, 3D rendering, mic input, and asset caching.

### Directory Structure (app)

| Directory                | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `assets/`                | Bundled game assets and preload/cache manifest             |
| `components/views/`      | Full-page views (title, join, game, preload, error)        |
| `components/panels/`     | Data tables and reusable info composites                   |
| `components/dialogs/`    | Modal popover windows                                      |
| `components/hud/`        | Always-visible gameplay UI elements                        |
| `components/primitives/` | Headless UI / ShadCN base components                       |
| `components/toasts/`     | Dismissible notifications                                  |
| `css/`                   | Tailwind 4 theme and custom utilities                      |
| `fx/`                    | Standalone effect components (mini map, glitch text, etc.) |
| `hooks/`                 | Reusable React hooks                                       |
| `stores/`                | Zustand store slices                                       |
| `types/`                 | TypeScript types and interfaces                            |
| `utils/`                 | Helpers and utilities                                      |
| `stories/`               | Ladle stories (excluded from build)                        |

## CI / CD

Automated via GitHub Actions (`.github/workflows/`):

- **CI** (`ci.yml`): Runs lint + build on PRs targeting `main` (when `client/` files change)
- **Deploy** (`deploy.yml`): Vercel preview on PR, production deploy on merge to `main`

The licensed font is fetched from private Supabase Storage during CI.

### Pre-commit Hooks

[Husky](https://typicode.github.io/husky/) runs [lint-staged](https://github.com/lint-staged/lint-staged) on every commit, auto-fixing ESLint and Prettier issues on staged `.ts`/`.tsx` files.

### Notes

- `app` depends on the `starfield` package. Turbo handles build order automatically.
- Do **not** enable the Vercel GitHub integration — deploys are handled entirely via GitHub Actions.
