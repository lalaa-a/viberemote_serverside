# Scaling Guide — Vibe Remote Server

Current baseline: **1 VPS (2 vCPU / 8 GB / 160 GB) + Supabase Free Tier**

---

## Where You Will Hit the Wall First

Before any tier planning, these are the concrete limits that will break things as users grow:

| Bottleneck | Free Tier Limit | What Breaks |
|---|---|---|
| Supabase DB size | 500 MB | Writes start failing |
| Supabase Realtime connections | 500 concurrent | Mobile + desktop clients can't subscribe |
| Supabase bandwidth | 5 GB/month | API calls throttled |
| Supabase DB connections | 60 direct | Connection errors under concurrent load |
| Rate limiter store | In-memory | Resets on restart; broken with multiple instances |
| `terminal_events` table | Unbounded growth | Slowest-growing bomb — no TTL, no archive |
| Single Express process | 1 CPU core used | Can't saturate the 2 vCPUs you already have |

---

## Tier 0 — Current (0–50 users)

**What you have now works. Ship it.**

One thing to do immediately that costs nothing:

### Run Express with PM2 in cluster mode
You're paying for 2 vCPUs but using 1. PM2 cluster mode forks one process per CPU:

```bash
npm install -g pm2
```

Create `ecosystem.config.js` at the project root:

```js
module.exports = {
  apps: [{
    name:      'vibe-remote',
    script:    'src/index.js',
    instances: 'max',       // one per CPU core
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
    },
  }],
}
```

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # auto-restart on reboot
```

**Problem this creates:** your in-memory rate limiter (`express-rate-limit` default store) is per-process. With 2 processes each allowing 120 req/min, the effective limit doubles to 240. Fix this in Tier 1 with Redis.

---

## Tier 1 — Early Growth (50–300 users)

**Primary action: Upgrade Supabase to Pro ($25/month).**

Pro removes the most dangerous limits:
- DB: 8 GB (vs 500 MB)
- Realtime connections: 10,000 (vs 500)
- Bandwidth: 250 GB/month
- **PgBouncer connection pooling** — this alone prevents connection exhaustion

### Add critical DB indexes

Run these in the Supabase SQL editor. Without them, every lookup does a full table scan:

```sql
-- Auth hot path (every request runs this)
CREATE INDEX IF NOT EXISTS idx_machines_api_key_hash
  ON machines(api_key_hash);

-- Session + request listing
CREATE INDEX IF NOT EXISTS idx_agents_user_id
  ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_machine_id
  ON agents(machine_id);
CREATE INDEX IF NOT EXISTS idx_pending_requests_machine_id_status
  ON pending_requests(machine_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_requests_user_id_status
  ON pending_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_requests_session_id
  ON pending_requests(session_id);

-- Terminal events (this table will be large)
CREATE INDEX IF NOT EXISTS idx_terminal_events_session_created
  ON terminal_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminal_events_user_created
  ON terminal_events(user_id, created_at DESC);

-- File system requests
CREATE INDEX IF NOT EXISTS idx_fs_requests_machine_status
  ON fs_requests(machine_id, status);

-- Mobile commands delivery hot path
CREATE INDEX IF NOT EXISTS idx_mobile_commands_machine_status
  ON mobile_commands(machine_id, status);
```

### Add terminal_events TTL cleanup

`terminal_events` has no expiry and grows forever. Enable `pg_cron` in Supabase (Dashboard → Database → Extensions) then run:

```sql
-- Delete terminal events older than 7 days, runs every hour
SELECT cron.schedule(
  'cleanup-terminal-events',
  '0 * * * *',
  $$DELETE FROM terminal_events WHERE created_at < NOW() - INTERVAL '7 days'$$
);

-- Delete decided requests older than 30 days
SELECT cron.schedule(
  'cleanup-old-requests',
  '0 3 * * *',
  $$DELETE FROM pending_requests
    WHERE status IN ('approved','denied','timeout')
    AND decided_at < NOW() - INTERVAL '30 days'$$
);
```

### Fix the rate limiter for multi-process

Install Redis locally on the VPS and use it as the rate-limit store so all PM2 workers share the same counter:

```bash
sudo apt install redis-server
sudo systemctl enable redis
```

```bash
npm install rate-limit-redis ioredis
```

In `src/index.js`, replace the rate limiter setup:

```js
const { RedisStore } = require('rate-limit-redis')
const Redis = require('ioredis')

const redis = new Redis({ host: '127.0.0.1', port: 6379 })

const globalLimiter = rateLimit({
  windowMs:        60_000,
  max:             120,
  standardHeaders: true,
  store:           new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  message:         { error: 'Too many requests, slow down' },
})

const registerLimiter = rateLimit({
  windowMs:        60_000,
  max:             5,
  standardHeaders: true,
  store:           new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  message:         { error: 'Too many requests, slow down' },
})
```

---

## Tier 2 — Sustained Growth (300–2,000 users)

At this scale the polling architecture becomes the bottleneck. Two endpoints are polled constantly regardless of whether anything has changed:

- `GET /machines/fs/pending` — every relay daemon, every 5 seconds
- `GET /mobile/command/next` — every relay daemon, every 10 seconds

With 500 machines that's **100 DB reads/second** doing nothing but returning empty rows.

### Replace polling with Server-Sent Events (SSE)

SSE lets the server push to a connected relay daemon instead of the daemon constantly asking. The connection stays open but is cheap (no threading, Node handles it with its event loop).

**New endpoint pattern for `fs/pending`:**

```js
// src/routes/machines.js
router.get('/fs/watch', requireMachineAuth, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.flushHeaders()

  // Subscribe to Supabase Realtime or Redis pub/sub for this machine's fs jobs
  const channel = supabase
    .channel(`fs-jobs-${req.machine.id}`)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'fs_requests',
      filter: `machine_id=eq.${req.machine.id}`,
    }, payload => {
      res.write(`data: ${JSON.stringify(payload.new)}\n\n`)
    })
    .subscribe()

  req.on('close', () => supabase.removeChannel(channel))
})
```

The relay daemon replaces its polling loop with an `EventSource` connection. This drops DB load from O(machines × poll_rate) to near zero between events.

### Cache computed fields in Redis

`is_online` and `deriveStatus()` are computed from DB timestamps on every request. Add a 30-second Redis cache:

```js
// src/utils.js
async function getMachineOnlineStatus(machineId, lastSeen) {
  const key = `machine:online:${machineId}`
  const cached = await redis.get(key)
  if (cached !== null) return cached === '1'

  const online = lastSeen && (Date.now() - new Date(lastSeen).getTime()) < 90_000
  await redis.setex(key, 30, online ? '1' : '0')
  return online
}
```

Invalidate on heartbeat and offline events (you already touch those rows, just also `redis.del(key)`).

### Upgrade the VPS

At this scale, upgrade to **4 vCPU / 16 GB RAM**. PM2 cluster mode will now use 4 cores. The cost difference is small; the headroom is significant.

### Add a push notification queue

Currently `notifyUser()` is fire-and-forget inline in the request handler. When FCM is slow or retrying, it ties up the event loop. Move it to a queue:

```bash
npm install bullmq
```

```js
// src/queues/notify.js
const { Queue, Worker } = require('bullmq')
const connection = new Redis({ host: '127.0.0.1', port: 6379 })

export const notifyQueue = new Queue('push-notify', { connection })

// Worker (runs in a separate process or same process)
new Worker('push-notify', async job => {
  await sendFcmPush(job.data.token, job.data.payload)
}, { connection })
```

In `relay.js` on upload, replace the inline `notifyUser()` call with `notifyQueue.add(...)`. Push delivery is now async, retried automatically on FCM failure, and doesn't delay the HTTP response.

---

## Tier 3 — Horizontal Scaling (2,000+ users)

At this point you need multiple server instances behind a load balancer.

### Architecture overview

```
                    ┌─────────────────┐
  Mobile/Desktop ──▶│  Load Balancer  │ (nginx or cloud LB)
                    └────────┬────────┘
                    ┌────────┴────────┐
              ┌─────┴──────┐   ┌─────┴──────┐
              │  App #1    │   │  App #2    │  (identical, stateless)
              └─────┬──────┘   └─────┬──────┘
                    └────────┬────────┘
               ┌─────────────┼─────────────┐
          ┌────┴───┐    ┌────┴───┐    ┌────┴────┐
          │ Redis  │    │Supabase│    │Firebase │
          └────────┘    └────────┘    └─────────┘
```

**Why this is already mostly ready:**
- Your server is stateless — no in-memory session state
- Auth is done against the DB on every request (no local token cache)
- The only stateful piece (rate limiter) is already fixed with Redis in Tier 1

### What you need before going horizontal

1. **Redis must be on a dedicated instance** (not localhost). Use a managed Redis (Upstash, Redis Cloud free tier, or a separate VPS).

2. **SSE connections need sticky routing** — if you add SSE in Tier 2, the load balancer needs `ip_hash` or cookie-based session affinity, or you switch SSE to use Redis pub/sub as the backend so any instance can push to any client.

3. **Supabase connection pooling via PgBouncer** (already on Pro tier) — point `SUPABASE_URL` to the pooler URL, not the direct connection.

4. **BullMQ workers as separate processes** — run one or two dedicated worker dynos/VMs for push notifications, separate from your API processes.

### Supabase tier at this scale

At 2,000+ active users, evaluate **Supabase Pro + Point-in-Time Recovery** or look at **self-hosting Supabase on a dedicated Postgres instance** (saves cost, more control). Alternatively, switch the Postgres layer to **Neon** (serverless, scales to zero, cheaper at variable load) while keeping Supabase Auth and Realtime.

---

## Quick Reference: What to Do at Each Stage

| Stage | Users | Action |
|---|---|---|
| Now | < 50 | PM2 cluster mode — free, immediate |
| Soon | 50 | Supabase Pro ($25/mo) + add DB indexes + pg_cron cleanup |
| Growing | 50–300 | Redis on VPS + fix rate limiter store |
| Scaling | 300–2k | Replace polling with SSE + Redis cache + push queue (BullMQ) + bigger VPS |
| Mature | 2k+ | Load balancer + multiple instances + dedicated Redis + PgBouncer pooler URL |

---

## Cost Projection

| Stage | Monthly Cost (approx) |
|---|---|
| Current | ~$12 VPS + $0 Supabase = **$12** |
| Tier 1 | ~$12 VPS + $25 Supabase = **$37** |
| Tier 2 | ~$24 VPS (4vCPU) + $25 Supabase = **$49** |
| Tier 3 | ~$48 (2× VPS) + $25 Supabase + ~$10 Redis = **$83** |

> These are rough DigitalOcean/Hetzner estimates. Actual costs depend on provider and traffic.
