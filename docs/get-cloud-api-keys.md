# How to Get Your Supabase Cloud API Keys

## Step 1: Open Your Project Settings

**Click this link:** https://app.supabase.com/project/pqmccexihlpnljcjfght/settings/api

This will take you directly to your project's API settings page.

## Step 2: Find the Keys on the Page

Once the page loads, you'll see a section called **"Project API keys"**.

### Finding the anon (public) key:

Look for a section labeled:
```
anon public
```

Below it, you'll see a long string that starts with `eyJ...` - this is your **SUPABASE_ANON_KEY**.

**It looks something like:**
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxbWNjZXhpaGxwbmxqY2pmaGdodCIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNjk...
```
(This will be much longer - around 200+ characters)

### Finding the service_role key:

Scroll down a bit and look for:
```
service_role secret
```

You'll see a box with `••••••••••••••••••` (hidden).

**Click the eye icon (👁️) or "Reveal" button** next to it.

This will show your **SUPABASE_SERVICE_ROLE_KEY** - another long string starting with `eyJ...`

## Step 3: Copy the Keys

1. **Select and copy the anon key** (the whole long string)
2. **Click reveal on service_role, then copy it**

## Step 4: Update .env.cloud

Open `.env.cloud` in your editor and replace:
- `YOUR_ANON_KEY_HERE` with the anon key you copied
- `YOUR_SERVICE_ROLE_KEY_HERE` with the service_role key you copied

## Visual Reference

The page layout looks like this:

```
Project API keys
────────────────
Project URL
https://pqmccexihlpnljcjfght.supabase.co
[Copy]

anon public
eyJhbGci... [long string here]
[Copy]

service_role secret
•••••••••••••••••
[👁️ Reveal] [Copy]
```

## Quick Check

Your keys should:
- ✅ Start with `eyJ`
- ✅ Be very long (200+ characters)
- ✅ Have no spaces
- ✅ Contain lots of dots (.) and random letters/numbers

## Need Help?

If you don't see the API keys section, make sure:
1. You're logged into Supabase (https://app.supabase.com)
2. The project pqmccexihlpnljcjfght exists and you have access to it
3. You're on the "Settings" → "API" page (not Database or other tabs)
