# Deploy

Full deployment: edge functions then bot.

## Parameters

The user specifies the environment as an argument: `/deploy dev` or `/deploy prod`. If not provided, ask which environment.

## Steps

### 0. Check version and offer release

Read the current version from `pyproject.toml` and the latest git tag. Report both to the user, e.g.:

```
Current version: 0.1.0
Latest tag: v0.1.0
```

Ask the user if they'd like to run `/release` first before deploying. If yes, run the release skill then continue. If no, proceed.

### 1. Deploy edge functions

Run the `/deploy-functions` skill.

### 2. Deploy bot

Run the `/deploy-bot <env>` skill with the same environment.
