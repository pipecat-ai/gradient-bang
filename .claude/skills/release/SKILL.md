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

### 4. Update CHANGELOG.md

In `CHANGELOG.md`:

1. Find the `## [Unreleased]` section
2. Insert a new version heading below it: `## [A.B.C] - YYYY-MM-DD` (today's date)
3. Move all content between `## [Unreleased]` and the next `## [` heading (or EOF) under the new version heading
4. Leave `## [Unreleased]` with an empty line beneath it (ready for new entries)

If there are no entries under Unreleased, warn the user but proceed.

### 5. Commit and tag

```bash
git add pyproject.toml deployment/supabase/functions/_shared/version.ts CHANGELOG.md
git commit -m "release: vA.B.C"
git tag vA.B.C
```

### 6. Report

Print the new version and remind the user:
- `git push && git push --tags` to push the release
- `/deploy` to deploy

## Does NOT

- Push to remote (user decides when)
- Deploy anything (use `/deploy` for that)
- Modify client versions (`client/app` and `client/starfield` are versioned separately)
