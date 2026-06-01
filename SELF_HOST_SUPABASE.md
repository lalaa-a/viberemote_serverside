# Self-Hosting Supabase on Your VPS

**Goal:** Run Supabase entirely on your own server (2 vCPU / 8 GB RAM / 160 GB Disk) so you pay $0 to Supabase.

**What you keep for free:** Postgres, Auth (GoTrue), Realtime, REST API (PostgREST), Storage, Studio dashboard — everything.

**What you lose:** Supabase support, their managed backups, their CDN, and automatic version upgrades. You handle all of that yourself.

---

## Before You Start — Is Your Server Big Enough?

| Service | Approx RAM |
|---|---|
| PostgreSQL | ~200 MB idle |
| PostgREST | ~50 MB |
| GoTrue (Auth) | ~50 MB |
| Realtime | ~100 MB |
| Kong (API gateway) | ~150 MB |
| Studio (dashboard) | ~200 MB |
| imgproxy + pg_meta + vector | ~200 MB |
| **Total Supabase stack** | **~950 MB – 1.5 GB** |
| Your Express app (PM2 × 2) | ~200 MB |
| OS + buffers | ~500 MB |
| **Total** | **~2 GB used / 8 GB available** |

You have plenty of headroom. 8 GB is comfortable for this stack.

---

## Step 1 — Install Docker and Docker Compose

SSH into your VPS and run:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (so you don't need sudo every time)
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version
docker compose version
```

---

## Step 2 — Download the Supabase Docker Setup

Supabase ships an official Docker Compose configuration. Do NOT clone the entire Supabase monorepo — it's gigabytes. Just pull the `docker` folder:

```bash
# Create a home for it
mkdir -p /opt/supabase && cd /opt/supabase

# Download only the docker directory (sparse checkout)
git clone --filter=blob:none --sparse https://github.com/supabase/supabase.git .
git sparse-checkout set docker
cd docker

# You now have:
# docker-compose.yml
# .env.example
# volumes/
```

---

## Step 3 — Generate Your Secrets

You need four secrets. Generate them now and save them somewhere safe — you cannot change most of these after the first start without breaking auth.

### 3a. Postgres password
```bash
openssl rand -base64 32
# Example output: xK3mP9qR2nL8vT5wY1jB6cD4aE7fG0hZ...
# Save this as POSTGRES_PASSWORD
```

### 3b. JWT secret
```bash
openssl rand -base64 40
# Example output: mN7pQ2rS5tU8vW1xY4zA3bC6dE9fG0hI...
# Save this as JWT_SECRET
```

### 3c. Anon key and Service role key

These are JWTs signed with your JWT secret. The easiest way to generate them is with this Node.js snippet — run it on your local machine:

```bash
npm install -g jsonwebtoken  # or just use node directly if you have it
```

```js
// gen-keys.js — run with: node gen-keys.js
const jwt = require('jsonwebtoken')

const JWT_SECRET = 'PASTE_YOUR_JWT_SECRET_HERE'

const anonKey = jwt.sign(
  { role: 'anon', iss: 'supabase', iat: 1741910400, exp: 1899676800 },
  JWT_SECRET
)

const serviceKey = jwt.sign(
  { role: 'service_role', iss: 'supabase', iat: 1741910400, exp: 1899676800 },
  JWT_SECRET
)

console.log('ANON_KEY=', anonKey)
console.log('SERVICE_ROLE_KEY=', serviceKey)
```

> `iat` and `exp` are Unix timestamps. The values above are 2025-03-14 → 2030-03-14. Use https://www.epochconverter.com if you want different dates. Keep `exp` far in the future — expiry breaks all API calls.

---

## Step 4 — Configure the .env File

```bash
cp .env.example .env
nano .env   # or vim .env
```

Fill in every value below. Anything not listed can keep its default:

```env
############################################
# Core secrets — fill these in
############################################
POSTGRES_PASSWORD=<your-postgres-password>
JWT_SECRET=<your-jwt-secret>
ANON_KEY=<your-anon-key>
SERVICE_ROLE_KEY=<your-service-role-key>

############################################
# Dashboard login (Studio UI)
############################################
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=<pick-a-strong-password>

############################################
# Your server's public address
# Use your VPS IP or domain name
# NO trailing slash
############################################
SITE_URL=https://your-domain.com
API_EXTERNAL_URL=https://your-domain.com

############################################
# SMTP — Supabase needs this to send
# confirmation/magic-link emails via GoTrue.
# Use a free Brevo (Sendinblue) or Mailgun account.
############################################
SMTP_ADMIN_EMAIL=noreply@your-domain.com
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<your-smtp-username>
SMTP_PASS=<your-smtp-password>
SMTP_SENDER_NAME=Vibe Remote

############################################
# Postgres defaults — leave as-is unless
# you know what you're changing
############################################
POSTGRES_HOST=db
POSTGRES_DB=postgres
POSTGRES_PORT=5432
```

> **SMTP is required.** GoTrue (the auth service) will fail to start properly without a valid SMTP config because it needs to send verification emails. Brevo has a free tier of 300 emails/day which is more than enough. Sign up at https://www.brevo.com and use their SMTP credentials.

---

## Step 5 — (Optional) Trim Services You Don't Use

Your app doesn't use Supabase Storage, Edge Functions, or the Analytics pipeline. Disabling them saves ~400 MB of RAM.

Open `docker-compose.yml` and comment out (add `#` before the service name line and all its contents) or delete these services:

- `storage` — Supabase Storage (you don't use it)
- `imgproxy` — Image transforms (only needed with Storage)
- `functions` — Edge Functions (you don't use them)
- `analytics` — Logflare analytics (nice to have, not needed)
- `vector` — Log collection (feeds analytics)

You **must keep:** `db`, `auth`, `rest`, `realtime`, `meta`, `kong`, `studio`

---

## Step 6 — Start Supabase

```bash
cd /opt/supabase/docker

# Pull all images first (takes a few minutes on first run)
docker compose pull

# Start in the background
docker compose up -d

# Watch the logs to confirm everything started cleanly
docker compose logs -f --tail=50
```

Wait for all services to show `healthy`. This takes 1–2 minutes on first boot while Postgres initialises.

### Verify it's running

```bash
# Should return {"status":200}
curl http://localhost:8000/rest/v1/  \
  -H "apikey: YOUR_ANON_KEY"
```

The Studio dashboard is available at `http://YOUR_SERVER_IP:3000` (or the port mapped in docker-compose.yml for the `studio` service — check with `docker compose ps`).

---

## Step 7 — Set Up Nginx + SSL

You need HTTPS. Your app clients (mobile + desktop) connect to Supabase URLs, and JWT-based auth should never go over plain HTTP.

### Install nginx and Certbot

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

### Create the nginx config

```bash
sudo nano /etc/nginx/sites-available/supabase
```

Paste this (replace `your-domain.com`):

```nginx
server {
    listen 80;
    server_name your-domain.com;
    # Certbot will handle the HTTP→HTTPS redirect after cert issuance
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    # SSL certs — Certbot fills these in
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # Increase body size for file uploads
    client_max_body_size 10m;

    # Supabase API (Kong gateway)
    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";   # Required for Realtime WS
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_read_timeout 3600s;   # Keep Realtime WS connections alive
        proxy_send_timeout 3600s;
    }

    # Studio dashboard — restrict to your IP if possible
    location /studio/ {
        proxy_pass       http://127.0.0.1:3000/;
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/supabase /etc/nginx/sites-enabled/
sudo nginx -t   # check for syntax errors

# Get the SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renew is set up by certbot automatically, verify:
sudo systemctl status certbot.timer
```

Now your Supabase is at `https://your-domain.com`.

---

## Step 8 — Migrate Your Schema and Data from Hosted Supabase

### Install the Supabase CLI on your local machine

```bash
npm install -g supabase
supabase login
```

### Export your schema

```bash
# Link to your hosted project first
supabase link --project-ref YOUR_PROJECT_REF

# Dump the schema (DDL only, no data)
supabase db dump -f schema.sql

# Dump the data separately
supabase db dump --data-only -f data.sql
```

> `YOUR_PROJECT_REF` is the string in your Supabase dashboard URL: `https://app.supabase.com/project/YOUR_PROJECT_REF`

### Export auth users

Auth users live in the `auth` schema which `db dump` skips by default. Export them separately:

```bash
supabase db dump --schema auth -f auth-schema.sql
```

For the user rows themselves (emails, hashed passwords, metadata):

```bash
# Connect to hosted Supabase Postgres directly
# Get the connection string from: Dashboard → Settings → Database → Connection string
pg_dump "postgresql://postgres:PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres" \
  --schema=auth \
  --data-only \
  --table=auth.users \
  --table=auth.identities \
  -f auth-users.sql
```

### Import into your self-hosted instance

```bash
# Copy files to the VPS
scp schema.sql data.sql auth-users.sql user@YOUR_VPS_IP:/opt/supabase/

# SSH in
ssh user@YOUR_VPS_IP

# Import schema
docker exec -i supabase-db-1 psql -U postgres -d postgres < /opt/supabase/schema.sql

# Import data
docker exec -i supabase-db-1 psql -U postgres -d postgres < /opt/supabase/data.sql

# Import auth users
docker exec -i supabase-db-1 psql -U postgres -d postgres < /opt/supabase/auth-users.sql
```

> The container name `supabase-db-1` may vary. Confirm with `docker compose ps` and look for the `db` service.

### Verify

Open Studio at `https://your-domain.com/studio` and check:
- Table Editor — your tables should be there with data
- Authentication → Users — your users should be listed

---

## Step 9 — Update Your App's Environment Variables

Replace the Supabase cloud values with your self-hosted ones:

```env
# Before (Supabase Cloud)
SUPABASE_URL=https://xyzabcdef.supabase.co
SUPABASE_ANON_KEY=eyJ...cloud-anon-key...
SUPABASE_SERVICE_KEY=eyJ...cloud-service-key...
SUPABASE_JWT_SECRET=super-secret-cloud-jwt

# After (Self-hosted)
SUPABASE_URL=https://your-domain.com
SUPABASE_ANON_KEY=<anon key you generated in Step 3c>
SUPABASE_SERVICE_KEY=<service role key you generated in Step 3c>
SUPABASE_JWT_SECRET=<jwt secret you generated in Step 3b>
```

Restart your Express app:

```bash
pm2 restart all
```

The desktop relay daemon and mobile app both use these values via your Express API — they never connect directly to Supabase URLs for REST calls. **However**, they do connect directly for **Realtime** (the mobile app calls `/mobile/realtime-token` then subscribes directly). Make sure the mobile app's hardcoded Supabase URL (if any) is updated too. Search the mobile codebase:

```bash
grep -r "supabase.co" AgentControl/src/
```

Replace any hits with your self-hosted domain.

---

## Step 10 — Set Up Automated Backups

Self-hosted means you own your backups. Set up a daily Postgres dump:

```bash
sudo mkdir -p /opt/backups/postgres
sudo nano /opt/backups/backup-postgres.sh
```

```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/opt/backups/postgres
KEEP_DAYS=7

# Dump from the running container
docker exec supabase-db-1 pg_dumpall -U postgres \
  | gzip > "$BACKUP_DIR/postgres_$TIMESTAMP.sql.gz"

# Delete backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +$KEEP_DAYS -delete

echo "Backup complete: postgres_$TIMESTAMP.sql.gz"
```

```bash
sudo chmod +x /opt/backups/backup-postgres.sh

# Schedule it daily at 2am
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/backups/backup-postgres.sh >> /opt/backups/backup.log 2>&1") | crontab -
```

**Optional but recommended:** copy backups off-server to S3, Backblaze B2, or even a free Cloudflare R2 bucket. A single disk failure would otherwise wipe everything.

```bash
# Example: sync backups to Cloudflare R2 using rclone
sudo apt install rclone -y
rclone config   # follow prompts to add R2 as a remote called "r2"

# Add to the backup script before the exit:
rclone copy "$BACKUP_DIR" r2:your-bucket-name/postgres-backups/
```

---

## Step 11 — Keep Supabase Updated

Docker Compose self-hosting means you update manually. Supabase releases are at: https://github.com/supabase/supabase/releases

```bash
cd /opt/supabase/docker

# Pull updated docker-compose.yml from Supabase
git pull

# Pull new images
docker compose pull

# Restart with zero-ish downtime (each service restarts one at a time)
docker compose up -d --remove-orphans

# Clean up old images
docker image prune -f
```

Do this once a month. Breaking changes are rare but always read the release notes before upgrading.

---

## Ports Reference

| Service | Internal Port | Exposed Via |
|---|---|---|
| Kong API gateway | 8000 | nginx → `https://your-domain.com` |
| Studio dashboard | 3000 | nginx → `https://your-domain.com/studio` |
| PostgreSQL | 5432 | NOT exposed externally — internal Docker network only |
| Realtime | 4000 | Proxied through Kong |

**Never expose port 5432 to the internet.** Postgres should only be accessible within the Docker network and via `docker exec`.

---

## Firewall Setup

```bash
sudo ufw allow ssh
sudo ufw allow 80/tcp    # HTTP (for Certbot renewals)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 3000/tcp  # Your Express API port (if different from 443)
sudo ufw deny 8000/tcp   # Kong — only nginx should reach this
sudo ufw deny 5432/tcp   # Postgres — never public
sudo ufw enable
```

---

## Troubleshooting Quick Reference

```bash
# See all running containers and their health
docker compose -f /opt/supabase/docker/docker-compose.yml ps

# View logs for a specific service
docker compose -f /opt/supabase/docker/docker-compose.yml logs auth -f

# Restart a single service without touching others
docker compose -f /opt/supabase/docker/docker-compose.yml restart realtime

# Connect to Postgres directly
docker exec -it supabase-db-1 psql -U postgres -d postgres

# Check disk usage by Docker volumes
docker system df
```

---

## What This Saves You

| | Supabase Cloud Pro | Self-Hosted |
|---|---|---|
| Monthly cost | $25/month | $0 (you pay the VPS you already have) |
| DB size limit | 8 GB | Limited only by your 160 GB disk |
| Realtime connections | 10,000 | Configured by you (default: effectively unlimited on your hardware) |
| Backups | Managed | Your responsibility (see Step 10) |
| Uptime SLA | 99.9% | Your responsibility |
| Version upgrades | Automatic | Manual (monthly, ~5 min) |

> **Total saving: $25/month = $300/year**, while gaining more control and no usage caps.
