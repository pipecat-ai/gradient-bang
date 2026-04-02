# Deploy

Full deployment: edge functions then bot.

## Parameters

The user specifies the environment as an argument: `/deploy dev` or `/deploy prod`. If not provided, ask which environment.

## Steps

1. Run the `/deploy-functions` skill
2. Run the `/deploy-bot <env>` skill with the same environment
