# Gradient Bang Client Packages

<img width="640" src="image.png" style="margin-bottom:20px;" />

## Quickstart

*Note: The game client looks best with the beautiful [TX-02 Berkeley Mono](https://usgraphics.com/products/berkeley-mono) typeface. We recommend you grab a license and place it in `app/src/assets/fonts/tx-02.woff2`*

#### Point client at server and bot URL (if not using default):

```bash
mv app/env.example .env
```

#### Build and run:

```bash 
pnpm i
pnpm run preview

# ...or for dev

pnpm run dev
```

### Joining your game world



## Development

### Packages

#### `/app`

Web game client (Vite, React, Typescript)

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

