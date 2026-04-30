---
name: release
description: Bump the project version (major/minor/patch), update CHANGELOG.md, and tag the release. Usage `/release <major|minor|patch>`.
---

# Release

Bump the Gradient Bang version, update the changelog, commit, and tag.

## Parameters

`/release <major|minor|patch>` — bump type required. If missing, ask.

## Steps

### 1. Read the current version

Read the `version` field from `pyproject.toml`. Parse it as `MAJOR.MINOR.PATCH`.

### 2. Compute the new version

Apply the requested bump:
- `major` → `MAJOR+1.0.0`
- `minor` → `MAJOR.MINOR+1.0`
- `patch` → `MAJOR.MINOR.PATCH+1`

Report: `Bumping version: X.Y.Z → A.B.C`

### 3. Update version in all locations

Update these files to the new version:

1. **`pyproject.toml`** — the `version = "X.Y.Z"` line
2. **`deployment/supabase/functions/_shared/version.ts`** — the `export const VERSION = "X.Y.Z";` line

### 4. Sync uv.lock

```bash
uv lock
```

The project itself is recorded in `uv.lock` (`name = "gradient-bang"`), so a `pyproject.toml` version bump invalidates the lockfile. The bot's Docker build runs `uv sync --locked` and will fail without this. No dependency changes — only the project's own version line moves.

### 5. Update CHANGELOG.md

In `CHANGELOG.md`:

1. Find the `## [Unreleased]` section
2. Insert a new version heading below it: `## [A.B.C] - YYYY-MM-DD` (today's date)
3. Move all content between `## [Unreleased]` and the next `## [` heading (or EOF) under the new version heading
4. Leave `## [Unreleased]` with an empty line beneath it (ready for new entries)

If there are no entries under Unreleased, warn the user but proceed.

### 6. Bump client versions

From the `client/` directory, run the matching pnpm bump script:

```bash
cd client && pnpm run bump:<major|minor|patch>
```

This bumps `client/app/package.json` and `client/starfield/package.json`, then rebuilds.

### 7. Commit, tag, and push

```bash
git add pyproject.toml deployment/supabase/functions/_shared/version.ts uv.lock CHANGELOG.md client/
git commit -m "release: vA.B.C"
git tag vA.B.C
git push origin HEAD
git push origin vA.B.C
```

Pushing the tag triggers `.github/workflows/release.yml`, which extracts the new `## [A.B.C]` section from `CHANGELOG.md` and creates the GitHub release.

### 8. Report

Print the new version and remind the user:
- GitHub release will be created automatically by the release workflow
- `/deploy` to deploy

## Does NOT

- Deploy anything (use `/deploy` for that)
