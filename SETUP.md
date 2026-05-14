# Vibe Remote Server — Setup Guide

Everything you need to get the backend running, from zero to a working API.

---

## Prerequisites

### 1. Node.js 18 or higher (22 recommended)

The server uses ES modules (`"type": "module"`), native `fetch`, and optional chaining (`?.`).
Older versions (especially Node 12/14) will crash with `SyntaxError: Unexpected token '.'`.

```bash
node --version   # must be >= 18.0.0
```

**If your version is too old, upgrade using NodeSource:**

```bash
# Ubuntu / Debian (VPS)
sudo apt remove -y nodejs
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
node --version   # should now print v22.x.x
```

**Windows / Mac:** download the LTS installer from [nodejs.org](https://nodejs.org).

---

### 2. A Supabase project

The server is the only piece that talks to Supabase with the service key.  
Everything else (desktop app, mobile app) uses only the anon key.

**Create a free project at [supabase.com](https://supabase.com)** → New Project.  
Note your **project URL** and both API keys — you will need them below.

---

## Step 1 — Run the database schema

Open your Supabase project → **SQL Editor** → paste and run the entire contents of:

```
relay-deamon1/database/schema.sql
```

(This file is in the desktop app repo. If you don't have it, the SQL is reproduced at the bottom of this guide.)

This creates:
- `machines` table — one row per registered dev machine
- `agents` table — one row per Claude Code session
- `pending_requests` table — every intercepted tool-use event
- All indexes, RLS policies, Realtime publication, and helper functions

**Verify it worked:** Supabase → Table Editor → you should see the three tables.

---

## Step 2 — Enable Realtime on the tables

Supabase → **Database → Replication** → confirm `pending_requests` and `machines` are listed under the `supabase_realtime` publication.

If they are missing, run in SQL Editor:

```sql
alter publication supabase_realtime add table pending_requests;
alter publication supabase_realtime add table machines;
```

---

## Step 3 — Get your credentials

From Supabase → **Project Settings → API**:

| Value | Where to find it |
|---|---|
| Project URL | Settings → API → Project URL |
| `anon` key | Settings → API → Project API Keys → `anon public` |
| `service_role` key | Settings → API → Project API Keys → `service_role` |

> The `service_role` key bypasses all Row Level Security.  
> It must only ever be in the server's `.env` — never in any app.

---

## Step 4 — Create your `.env`

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=eyJ...your_anon_key...
SUPABASE_SERVICE_KEY=eyJ...your_service_role_key...
PORT=3000
```

The `.env` file is in `.gitignore` — it will never be committed.

---

## Step 5 — Install dependencies

```bash
npm install
```

---

## Step 6 — Run the server

**Development (auto-restarts on file changes):**

```bash
npm run dev
```

**Production:**

```bash
npm start
```

You should see:

```
Vibe Remote API listening on port 3000
Supabase project: https://your-project-id.supabase.co
```

**Verify it works:**

```bash
curl http://localhost:3000/health
# {"ok":true,"ts":"2026-05-13T..."}
```

---

## Step 7 — Point the desktop app at this server

In `vibe_remote(dekstop)/my-app/src/lib/supabase.js`, update `API_URL`:

```js
// Local development
export const API_URL = 'http://localhost:3000';

// Production (after deploying to VPS)
export const API_URL = 'https://your-domain.com';
```

---

## Deploying to a VPS (DigitalOcean)

### Minimum spec
- **$6/month Basic Droplet** — 1 GB RAM, 1 vCPU, Ubuntu 24.04 LTS
- Covered entirely by the GitHub Student Pack ($200 credit)

### Steps

**1. SSH into your droplet**
```bash
ssh root@your-droplet-ip
```

**2. Install Node.js**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
```

**3. Install PM2 (process manager — keeps the server alive)**
```bash
sudo npm install -g pm2
```

**4. Clone and set up the project**
```bash
git clone https://github.com/your-username/vibe-remote-server.git
cd vibe-remote-server
npm install
cp .env.example .env
nano .env          # paste your real Supabase credentials
```

**5. Start with PM2**
```bash
pm2 start src/index.js --name vibe-remote-api
pm2 save           # persist across reboots
pm2 startup        # generate the startup command and run it
```

**6. Set up HTTPS with Caddy (free, automatic SSL)**
```bash
sudo apt install -y caddy
```

Edit `/etc/caddy/Caddyfile`:
```
your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

Your API is now live at `https://your-domain.com` with auto-renewing SSL.

**7. Update `API_URL` in the desktop app** to `https://your-domain.com`, then rebuild the `.exe`.

---

## Useful PM2 commands

```bash
pm2 status                    # check if server is running
pm2 logs vibe-remote-api      # tail live logs
pm2 restart vibe-remote-api   # restart after code update
pm2 stop vibe-remote-api      # stop the server
```

---

## API Reference

All endpoints return JSON. Errors always have an `{ "error": "..." }` field.

### Authentication

| Route group | How to authenticate |
|---|---|
| `POST /machines/register` | `Authorization: Bearer <supabase_user_jwt>` |
| `POST /machines/heartbeat` | `x-machine-api-key: <raw_machine_api_key>` |
| `POST /relay/upload` | `x-machine-api-key: <raw_machine_api_key>` |
| `POST /relay/decide` | `x-machine-api-key: <raw_machine_api_key>` |
| `GET /relay/status/:id` | `x-machine-api-key: <raw_machine_api_key>` |

### `POST /machines/register`
Registers a new machine. Called by the desktop app on first launch after sign-in.

**Body:**
```json
{
  "machineId":   "uuid-v4",
  "machineLabel": "DESKTOP-ABC123",
  "apiKeyHash":  "sha256-hex-of-machine-api-key"
}
```

**Response:** `{ "ok": true, "machineId": "..." }`

---

### `POST /relay/upload`
Uploads a pending tool-use event from the relay hook.

**Body:**
```json
{
  "payload": {
    "tool_name": "Bash",
    "display_type": "bash",
    "summary": "Run npm install",
    "risk_level": "low",
    "command": "npm install"
  }
}
```

**Response:** `{ "id": "pending-request-uuid" }`

---

### `POST /relay/decide`
Sets the decision for a pending request (called by `relay.cjs` from the PC terminal).

**Body:**
```json
{
  "requestId": "pending-request-uuid",
  "decision":  "approved"
}
```

**Response:** `{ "ok": true }`

---

### `GET /relay/status/:requestId`
Polls the current status of a request (fallback if Supabase Realtime is unavailable).

**Response:** `{ "status": "approved", "decided_by": "mobile", "decided_at": "..." }`

---

## Database Schema (SQL)

If you don't have the `schema.sql` file, run this in Supabase SQL Editor:

```sql
create extension if not exists "pgcrypto";

drop table  if exists pending_requests cascade;
drop table  if exists agents           cascade;
drop table  if exists machines         cascade;

create table machines (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  label        text not null,
  api_key_hash text not null unique,
  is_online    bool default false,
  last_seen    timestamptz,
  created_at   timestamptz default now()
);

create table agents (
  id          uuid primary key default gen_random_uuid(),
  machine_id  uuid references machines(id) on delete cascade not null,
  session_id  text unique,
  name        text,
  started_at  timestamptz default now()
);

create table pending_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  machine_id    uuid references machines(id)   on delete cascade not null,
  agent_id      uuid references agents(id)     on delete set null,
  session_id    text,
  tool_name     text not null,
  display_type  text not null,
  summary       text not null,
  risk_level    text not null default 'low',
  risk_reason   text,
  risk_icon     text,
  files_affected text[] default '{}',
  diff          jsonb,
  command       text,
  file_path     text,
  new_content   text,
  old_content   text,
  raw_input     jsonb,
  status        text not null default 'pending',
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index idx_requests_user_status on pending_requests (user_id, status, created_at desc);
create index idx_requests_id_status   on pending_requests (id, status);
create index idx_requests_machine     on pending_requests (machine_id, status);
create index idx_machines_user        on machines (user_id, is_online);

alter table machines         enable row level security;
alter table agents           enable row level security;
alter table pending_requests enable row level security;

create policy "users own their machines"
  on machines for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "users own their agents"
  on agents for all
  using (machine_id in (select id from machines where user_id = auth.uid()));

create policy "users own their requests"
  on pending_requests for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table pending_requests;
alter publication supabase_realtime add table machines;
```

---

## Checklist Before Going to Production

- [ ] Schema applied in Supabase
- [ ] Realtime enabled on `pending_requests` and `machines`
- [ ] `.env` filled with real credentials (not the example values)
- [ ] Server starts with no errors (`npm start`)
- [ ] `/health` returns `{"ok":true}`
- [ ] Desktop app `API_URL` updated to the VPS URL
- [ ] Desktop app rebuilt (`npm run make`) with the new `API_URL`
- [ ] Test: sign up → machine registers → QR code appears → toggle works
