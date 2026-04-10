# Deploy Bot

Deploys the bot to Pipecat Cloud using cloud builds.

## Parameters

The user specifies the environment as an argument: `/deploy-bot dev`, `/deploy-bot eval`, or `/deploy-bot prod`. If not provided, ask which environment to deploy to.

- `dev` → config file: `deployment/pcc-deploy.dev.toml`
- `eval` → config file: `deployment/pcc-deploy.eval.toml`
- `prod` → config file: `deployment/pcc-deploy.prod.toml`

## Steps

### 1. Deploy to Pipecat Cloud

```bash
pipecat cloud deploy --config-file deployment/pcc-deploy.<env>.toml --yes
```

The `--yes` flag skips all confirmation prompts. Pipecat Cloud will build the Docker image remotely using the Dockerfile and context specified in the toml file.

### 2. Verify

Report the result. The deploy command has a 90-second health check window that will often time out with a message like "Deployment did not enter ready state within 90 seconds." This is normal — the deployment was still submitted successfully. Treat this as a successful deploy and report the agent name.

If the build fails, check the build logs using the build ID from the error output:

```bash
pipecat cloud build logs <build-id>
```

## Important notes

- Config files are at `deployment/pcc-deploy.dev.toml` and `deployment/pcc-deploy.prod.toml`.
- The `.dockerignore` at the repo root controls what gets included in the build context.
- Secrets should already be configured on Pipecat Cloud. If the user hasn't set secrets yet, remind them to do so.
