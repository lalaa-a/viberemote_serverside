What was updated

src/routes/relay.js — 3 additions

Each existing write now stamps harness from the payload, defaulting to 'claude-code' so all existing Claude Code traffic is unchanged:
- POST /relay/agent-ping → agents.harness
- POST /relay/upload → pending_requests.harness
- POST /relay/terminal-event → terminal_events.harness

src/routes/mobile.js — 2 additions

- GET /mobile/sessions now returns harness on each session row (phone can badge it)
- GET /mobile/command/next now returns harness on the delivered command (heartbeat routes injection to the right adapter)

src/routes/harness.js — new file, 4 routes

┌─────────────────────────────────┬─────────────┬──────────────────────────────────────────────────────────┐
│              Route              │    Auth     │                         Purpose                          │
├─────────────────────────────────┼─────────────┼──────────────────────────────────────────────────────────┤
│ POST /harness/report            │ machine key │ Desktop pushes installed harness inventory + state       │
├─────────────────────────────────┼─────────────┼──────────────────────────────────────────────────────────┤
│ GET /harness/desired            │ machine key │ Desktop polls for phone-requested toggles                │
├─────────────────────────────────┼─────────────┼──────────────────────────────────────────────────────────┤
│ GET /harness/:machineId         │ user JWT    │ Mobile reads harness state for a machine                 │
├─────────────────────────────────┼─────────────┼──────────────────────────────────────────────────────────┤
│ POST /harness/:machineId/desire │ user JWT    │ Mobile requests a toggle (desktop applies it within 15s) │
└─────────────────────────────────┴─────────────┴──────────────────────────────────────────────────────────┘

src/index.js — mounted harnessRouter

migrations/003_multiharness.sql — run this on the VPS

# SSH into the VPS, then:
docker exec -i supabase-db-1 psql -U postgres -d postgres \
  < /path/to/migrations/003_multiharness.sql

Adds the harness column (default 'claude-code') to pending_requests, agents, and terminal_events, creates the machine_harnesses table with RLS, and three indexes. Fully additive — existing data and the old app are unaffected.

Then restart the Express app:

pm2 restart all

After that, the desktop's harness-cli.js report (which was getting 404) will return 200, and the phone can read harness state via GET /harness/:machineId.