# CLAUDE.md (Deployment)

## Deployment overview

This folder is a subdirectory of the main Gradient Bang project that contains file for deployment. The project requires three deployment steps:

- Supabase Edge functions (deployed to Supabase)
- Pipecat bot (deployed to Pipecat Cloud)
- Client (deployed to Vercel)

The Supabase Edge functions (referred to as "game server") and Pipecat bot (referred to as "bot") connect to one other, details of which are stored in their respective .env files and secrets.

The client has a single env variable that points it to the game server.

Important: deployment steps through the initial setup first (creating accounts, setting secrets etc.) You can answer questions about that using the deployment steps in the root README.md. When I ask you to deploy, however, stick to the steps detailed here.

## Enviroment setup

- Game server uses secrets set in `.env.cloud`
- Bot uses secrets set in `.env.bot.cloud`

When I ask you run a deployment for me, you have my permission to use these files.

The correct stucture for these can be found in:

- Game server: `env.supabase.example`
- Bot: `env.bot.example`
- Client: `client/env.example`

## Deployment steps

It's critical to ensure deployment steps are run in an environment with the correct .env exports

### Step 1. Ensure the integrity of the .env files

Check that the .env.cloud and .env.bot.cloud are correctly configured.

### Step 2. Deploy game server (supabase edge functions)

```bash
set -a && source .env.cloud && set +a
npx supabase functions deploy --workdir deployment/ --no-verify-jwt
```

### Step 3. Update the Pipecat Cloud bot

Before building the docker image:

1. Check Docker is running
2. Ask me what registry I want to use. Without a registry, the command would look like:

```
docker build -f deployment/Dockerfile.bot -t gb-bot:latest .
```

... but we should target a registry, e.g:

```
docker build -f deployment/Dockerfile.bot -t my-registry/gb-bot:latest .
```

Once the image has built, push it:

```
docker push gb-bot:latest
```

We then need to deploy this image to Pipecat Cloud.

Run the following command first:

```
pipecat cloud auth login
```

Then run the deploy command with the following caveat:

If pulling from a private registry:

```
cd deployment/
pipecat cloud deploy --force
```

If deploying from a public registry:

```
cd deployment/
pipecat cloud deploy --no-credentials --force
```

### Step 4. Deploy client to Vercel

```
cd client/
pnpm run build
vercel deploy
```
