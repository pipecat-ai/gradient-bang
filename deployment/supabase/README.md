# Supabase - Jon's Setup Notes

#### Update environment with the following:

- Find your Supabase URL here: https://supabase.com/dashboard/project/{YOUR_PROJECT_ID}/settings/api
- Find your Service Role Key here: https://supabase.com/dashboard/project/{YOUR_PROJECT_ID}/settings/api-keys

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

#### Apply schema to your Supabase database

Note: If using a free tier account, IPv4 is not available and the below will not work. 

We should make a script using the Supabase Python client to apply the schema vs. requiring IPv4 add-on (which is $4) BUT a lot of platforms to not support IPv6, e.g. Vercel, Render, etc. This complicates the game server deployment, so I think we should enforce
IPv4 as part of the setup.

_"Direct connections to the database only work if your client is able to resolve IPv6 addresses. Enabling the dedicated IPv4 add-on allows you to directly connect to your database via a IPv4 address."_


```bash
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-ID].supabase.co:5432/postgres" \
  -f deployment/supabase/schema.sql
```


#### Create a universe and sync to your Supabase project

```bash
# Sync all groups (dev, worldgen, server and bot)
uv sync --all-groups

# Create new world data
uv run universe-bang 5000 1234

# Load it to Supabase
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/ --force 
```