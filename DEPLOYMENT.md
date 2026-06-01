# Vibe Remote — DigitalOcean Deployment Guide

## Overview

The backend is a stateless Express relay API. The database lives in Supabase (off-box), so the droplet only runs Node. The workload is I/O-bound: small JSON requests and polling endpoints (`heartbeat` every 30 s, `fs/pending` every 5 s, `command/next` every 10 s), each doing 1–3 Supabase round trips.

---

## Recommended Droplet

| Phase | Droplet Type | Specs | ~Cost/mo | Trigger |
|---|---|---|---|---|
| **Launch** | Basic — Premium AMD | 2 vCPU / 2 GB / 60 GB NVMe | ~$21 | MVP → first real users |
| **Scale up** | Basic — Premium AMD | 4 vCPU / 8 GB | ~$56 | CPU or connection pressure |
| **Scale out** | 2+ droplets + Load Balancer | 2 vCPU / 2 GB each + LB ($12) | ~$54+ | Redundancy / multi-box traffic |

> **Region:** Deploy in the same region as your Supabase project. Every request makes a Supabase round trip — co-locating cuts your dominant latency source.

---

## Initial Server Setup

```bash
# 1. Create a non-root user
adduser deploy
usermod -aG sudo deploy
su - deploy

# 2. Install Node 22 LTS (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm use 22 && nvm alias default 22

# 3. Install PM2
npm install -g pm2

# 4. Install Nginx
sudo apt update && sudo apt install -y nginx

# 5. Clone and install the app
git clone <your-repo-url> /home/deploy/vibe-remote
cd /home/deploy/vibe-remote
npm install --omit=dev
cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY
```

---

## PM2 Config

Create `ecosystem.config.cjs` in the project root:

```js
module.exports = {
  apps: [{
    name: 'vibe-remote',
    script: 'src/index.js',
    instances: 'max',       // one worker per vCPU
    exec_mode: 'cluster',
    env: { NODE_ENV: 'production' },
  }],
}
```

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

---

## Nginx Config

`/etc/nginx/sites-available/vibe-remote`:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/vibe-remote /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# TLS via Certbot
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

## Required Code Fixes Before Production

### 1. Trust proxy (critical for rate limiting)

With Nginx in front, `req.ip` resolves to the proxy IP — every client shares one rate-limit bucket. Add this to `src/index.js` before the `rateLimit` middleware:

```js
app.set('trust proxy', 1)
```

### 2. Shared rate-limit store (required for horizontal scaling)

The default in-memory store doesn't survive restarts and isn't shared across droplets. Install a Redis-backed store before adding a second droplet:

```bash
npm install rate-limit-redis ioredis
```

```js
import { RedisStore } from 'rate-limit-redis'
import Redis from 'ioredis'

const redis = new Redis(process.env.REDIS_URL)

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  message: { error: 'Too many requests, slow down' },
})
```

Use **DO Managed Caching (Valkey)** for the Redis URL — starts at ~$15/mo.

---

## Horizontal Scaling (Phase 3)

1. Take a **Droplet Snapshot** of the working single-node setup.
2. Provision additional droplets from the snapshot within the same **VPC**.
3. Create a **DO Load Balancer** (`$12/mo`) pointing to all droplets on port 443.
4. Move TLS termination to the LB — remove the `ssl` block from Nginx, listen on 80 internally.
5. Ensure `REDIS_URL` points to the shared Managed Caching instance on all nodes.

---

## Firewall (UFW)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

For internal VPC traffic (horizontal scaling), also allow port 3000 from the VPC CIDR only.

---

## Health Check

The `/health` endpoint is already implemented:

```
GET /health → { ok: true, ts: "..." }
```

Use this as the LB health-check target with a 10 s interval and 2 failure threshold.

---

## Alternative: App Platform

If you prefer zero server admin, **DigitalOcean App Platform** deploys straight from Git, handles TLS and load balancing, and autoscales on a slider. A Professional tier instance starts at ~$12–25/mo. The `trust proxy` and Redis rate-limit fixes still apply once you run more than one instance.
