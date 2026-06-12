import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { db, authClient } from '../supabase.js'
import { requireMachineAuth } from '../middleware/auth.js'
import { syncAgentPendingCount, deriveStatus } from '../utils.js'

const ONLINE_THRESHOLD_MS = 90_000

const router = Router()

// GET /mobile/machine — verify credentials (auth middleware already did the DB lookup)
router.get('/machine', requireMachineAuth, (req, res) => {
  res.json(req.machine)
})

// POST /mobile/realtime-token — issue a Supabase JWT for Realtime auth.
// Tries two methods in order:
//   1. Sign a custom JWT with SUPABASE_JWT_SECRET (fast, no round-trip)
//   2. Fall back to admin.generateLink magic-link token exchange (no secret needed)
router.post('/realtime-token', requireMachineAuth, async (req, res) => {
  // ── Method 1: sign with JWT secret if available ────────────────────────────
  const secret = process.env.SUPABASE_JWT_SECRET
  if (secret) {
    const nowSec = Math.floor(Date.now() / 1000)
    const token  = jwt.sign(
      { sub: req.machine.user_id, role: 'authenticated', iat: nowSec, exp: nowSec + 60 * 60 * 12 },
      secret,
      { algorithm: 'HS256' }
    )
    return res.json({ token, expiresAt: nowSec + 60 * 60 * 12 })
  }

  // ── Method 2: admin generateLink + verifyOtp token exchange ──────────────
  // Used when the JWT secret is not accessible.
  // admin.generateLink does NOT send an email — it only generates the link.
  // We immediately exchange the hashed_token for a real session via verifyOtp.
  try {
    const { data: userData, error: userErr } = await db.auth.admin.getUserById(req.machine.user_id)
    if (userErr || !userData?.user?.email) {
      console.error('[realtime-token] getUserById failed:', userErr?.message ?? 'no email')
      return res.status(500).json({ error: 'Realtime token unavailable' })
    }

    const { data: linkData, error: linkErr } = await db.auth.admin.generateLink({
      type:  'magiclink',
      email: userData.user.email,
    })
    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error('[realtime-token] generateLink failed:', linkErr?.message)
      return res.status(500).json({ error: 'Realtime token unavailable' })
    }

    // Exchange hashed_token for a real session JWT — this is the documented path
    const { data: sessionData, error: sessionErr } = await authClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type:       'email',
    })
    if (sessionErr || !sessionData?.session?.access_token) {
      console.error('[realtime-token] verifyOtp failed:', sessionErr?.message)
      return res.status(500).json({ error: 'Realtime token unavailable' })
    }

    const expiresAt = Math.floor(new Date(sessionData.session.expires_at).getTime() / 1000)
    return res.json({ token: sessionData.session.access_token, expiresAt })
  } catch (err) {
    console.error('[realtime-token] fallback failed:', err.message)
    return res.status(500).json({ error: 'Realtime token unavailable' })
  }
})

// ── Sessions ──────────────────────────────────────────────────────────────────

// GET /mobile/sessions — all sessions across all of this user's machines
router.get('/sessions', requireMachineAuth, async (req, res) => {
  const { data: machines, error: machinesErr } = await db
    .from('machines')
    .select('id')
    .eq('user_id', req.machine.user_id)

  if (machinesErr) {
    console.error('[mobile/sessions] machines lookup', machinesErr.message)
    return res.status(500).json({ error: 'Failed to fetch sessions' })
  }

  const machineIds = (machines ?? []).map(m => m.id)
  if (!machineIds.length) return res.json([])

  const { data: agents, error } = await db
    .from('agents')
    .select('*, machines(id, label, is_online, last_seen)')
    .in('machine_id', machineIds)
    .order('last_activity_at', { ascending: false, nullsFirst: false })

  if (error) {
    console.error('[mobile/sessions]', error.message)
    return res.status(500).json({ error: 'Failed to fetch sessions' })
  }

  const now = Date.now()
  const sessions = (agents ?? []).map(agent => ({
    id:               agent.id,
    machine_id:       agent.machine_id,
    machine_label:    agent.machines?.label ?? 'Unknown',
    machine_is_online: agent.machines?.last_seen
      ? (now - new Date(agent.machines.last_seen).getTime()) < ONLINE_THRESHOLD_MS
      : false,
    session_id:       agent.session_id,
    cwd:              agent.cwd,
    harness:          agent.harness ?? 'claude-code',
    status:           deriveStatus(agent.last_activity_at),
    pending_count:    agent.pending_count ?? 0,
    last_activity_at: agent.last_activity_at,
    started_at:       agent.started_at,
  }))

  res.json(sessions)
})

// GET /mobile/sessions/:sessionId/requests
// ?pending=true  → only pending (default for approval screens)
// ?pending=false → all statuses (for chat feed, default when building history)
router.get('/sessions/:sessionId/requests', requireMachineAuth, async (req, res) => {
  const { data: machines } = await db
    .from('machines')
    .select('id')
    .eq('user_id', req.machine.user_id)

  const machineIds = (machines ?? []).map(m => m.id)
  if (!machineIds.length) return res.json([])

  let query = db
    .from('pending_requests')
    .select('*, machines(id, label, is_online)')
    .in('machine_id', machineIds)
    .eq('session_id', req.params.sessionId)
    .order('created_at', { ascending: true })

  // Only filter to pending when caller explicitly requests it
  if (req.query.pending === 'true') {
    query = query.eq('status', 'pending')
  }

  const { data, error } = await query.limit(100)

  if (error) {
    console.error('[mobile/sessions/:sessionId/requests]', error.message)
    return res.status(500).json({ error: 'Failed to fetch session requests' })
  }

  res.json(data ?? [])
})

// ── Requests ──────────────────────────────────────────────────────────────────

// GET /mobile/requests — all pending requests for this machine
router.get('/requests', requireMachineAuth, async (req, res) => {
  const { data, error } = await db
    .from('pending_requests')
    .select('*, machines(id, label, is_online)')
    .eq('machine_id', req.machine.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[mobile/requests]', error.message)
    return res.status(500).json({ error: 'Failed to fetch requests' })
  }

  res.json(data ?? [])
})

// GET /mobile/requests/:id — single request detail
router.get('/requests/:id', requireMachineAuth, async (req, res) => {
  const { data, error } = await db
    .from('pending_requests')
    .select('*, machines(id, label, is_online)')
    .eq('id', req.params.id)
    .eq('machine_id', req.machine.id)
    .single()

  if (error || !data) {
    return res.status(404).json({ error: 'Request not found' })
  }

  res.json(data)
})

// GET /mobile/history — recently decided requests
router.get('/history', requireMachineAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)

  const { data, error } = await db
    .from('pending_requests')
    .select('*, machines(id, label, is_online)')
    .eq('machine_id', req.machine.id)
    .in('status', ['approved', 'denied', 'timeout', 'cli_pending'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[mobile/history]', error.message)
    return res.status(500).json({ error: 'Failed to fetch history' })
  }

  res.json(data ?? [])
})

// POST /mobile/decide — approve or deny a request
router.post('/decide', requireMachineAuth, async (req, res) => {
  const { requestId, decision } = req.body

  if (!requestId || !decision) {
    return res.status(400).json({ error: 'requestId and decision are required' })
  }
  if (!['approved', 'denied'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or denied' })
  }

  // Fetch agent_id first so we can sync count after the update
  const { data: reqRow } = await db
    .from('pending_requests')
    .select('agent_id')
    .eq('id', requestId)
    .eq('machine_id', req.machine.id)
    .single()

  const { error } = await db
    .from('pending_requests')
    .update({
      status:     decision,
      decided_at: new Date().toISOString(),
      decided_by: 'mobile',
    })
    .eq('id', requestId)
    .eq('machine_id', req.machine.id)
    .eq('status', 'pending')

  if (error) {
    console.error('[mobile/decide]', error.message)
    return res.status(500).json({ error: 'Failed to update decision' })
  }

  await syncAgentPendingCount(reqRow?.agent_id)

  res.json({ ok: true })
})

// GET /mobile/machines — all machines for this user
// is_online is derived from last_seen so crashes appear offline automatically
router.get('/machines', requireMachineAuth, async (req, res) => {
  const { data, error } = await db
    .from('machines')
    .select('id, label, is_online, last_seen, created_at')
    .eq('user_id', req.machine.user_id)
    .order('last_seen', { ascending: false })

  if (error) {
    console.error('[mobile/machines]', error.message)
    return res.status(500).json({ error: 'Failed to fetch machines' })
  }

  const now = Date.now()
  const machines = (data ?? []).map(m => ({
    ...m,
    is_online: m.last_seen
      ? (now - new Date(m.last_seen).getTime()) < ONLINE_THRESHOLD_MS
      : false,
  }))

  res.json(machines)
})

// POST /mobile/push-token — register or update FCM push token
router.post('/push-token', requireMachineAuth, async (req, res) => {
  const { token, platform } = req.body

  if (!token) {
    return res.status(400).json({ error: 'token is required' })
  }

  const { error } = await db
    .from('push_tokens')
    .upsert(
      {
        machine_id: req.machine.id,
        user_id:    req.machine.user_id,
        token,
        platform:   platform || 'android',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' }
    )

  if (error) {
    console.error('[mobile/push-token]', error.message)
    return res.status(500).json({ error: 'Failed to save push token' })
  }

  res.json({ ok: true })
})

// ── Prompt injection ──────────────────────────────────────────────────────────

// POST /mobile/prompt — queue a prompt for delivery when the session is idle
router.post('/prompt', requireMachineAuth, async (req, res) => {
  const { prompt, sessionId } = req.body

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' })
  }

  // Resolve machine_id from sessionId — target may be a different machine than the caller
  let targetMachineId = req.machine.id
  if (sessionId) {
    const { data: agent } = await db
      .from('agents')
      .select('machine_id, machines(user_id)')
      .eq('session_id', sessionId)
      .single()

    if (!agent || agent.machines?.user_id !== req.machine.user_id) {
      return res.status(403).json({ error: 'Session not found or access denied' })
    }
    targetMachineId = agent.machine_id
  }

  const { data, error } = await db
    .from('mobile_commands')
    .insert({
      machine_id: targetMachineId,
      user_id:    req.machine.user_id,
      session_id: sessionId ?? null,
      prompt,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[mobile/prompt]', error.message)
    return res.status(500).json({ error: 'Failed to queue prompt' })
  }

  res.json({ id: data.id })
})

// GET /mobile/prompts — list recent prompts for this user (all machines)
router.get('/prompts', requireMachineAuth, async (req, res) => {
  const { data: machines } = await db
    .from('machines')
    .select('id')
    .eq('user_id', req.machine.user_id)

  const machineIds = (machines ?? []).map(m => m.id)
  if (!machineIds.length) return res.json([])

  const { data, error } = await db
    .from('mobile_commands')
    .select('id, session_id, prompt, status, created_at, delivered_at')
    .in('machine_id', machineIds)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) {
    console.error('[mobile/prompts]', error.message)
    return res.status(500).json({ error: 'Failed to fetch prompts' })
  }

  res.json(data ?? [])
})

// DELETE /mobile/prompt/:id — cancel a prompt that hasn't been delivered yet
router.delete('/prompt/:id', requireMachineAuth, async (req, res) => {
  const { error } = await db
    .from('mobile_commands')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .eq('user_id', req.machine.user_id)
    .eq('status', 'pending')

  if (error) {
    console.error('[mobile/prompt DELETE]', error.message)
    return res.status(500).json({ error: 'Failed to cancel prompt' })
  }

  res.json({ ok: true })
})

// GET /mobile/command/next — called by heartbeat.js every 10s
// Returns the oldest pending command only when the target session is fully idle.
router.get('/command/next', requireMachineAuth, async (req, res) => {
  const { data: commands } = await db
    .from('mobile_commands')
    .select('*')
    .eq('machine_id', req.machine.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(10)

  if (!commands?.length) return res.json(null)

  // Claude must have been idle for at least 30s (guards against brief pending_count=0 gaps
  // between chained tool calls). Also accepts agents with NULL last_activity_at (pre-migration rows).
  const idleThreshold = new Date(Date.now() - 30_000).toISOString()

  for (const cmd of commands) {
    let query = db
      .from('agents')
      .select('id, session_id, cwd, harness, pending_count, last_activity_at')
      .eq('machine_id', req.machine.id)
      .eq('pending_count', 0)
      .or(`last_activity_at.lt.${idleThreshold},last_activity_at.is.null`)

    if (cmd.session_id) {
      query = query.eq('session_id', cmd.session_id)
    }

    const { data: agents } = await query.limit(1)

    if (!agents?.length) {
      // Log why delivery is blocked so the server terminal shows it
      const { data: blocker } = await db
        .from('agents')
        .select('session_id, pending_count, last_activity_at')
        .eq('machine_id', req.machine.id)
        .eq('session_id', cmd.session_id ?? '')
        .maybeSingle()

      if (blocker) {
        console.log(`[command/next] blocked — session ${cmd.session_id} pending_count=${blocker.pending_count} last_activity=${blocker.last_activity_at}`)
      } else {
        console.log(`[command/next] blocked — no agent row found for session ${cmd.session_id ?? '(any)'}`)
      }
      continue
    }

    const agent = agents[0]

    // Atomically claim — optimistic lock on status=pending prevents double-delivery
    const { data: claimed, error: claimErr } = await db
      .from('mobile_commands')
      .update({ status: 'delivered', delivered_at: new Date().toISOString() })
      .eq('id', cmd.id)
      .eq('status', 'pending')
      .select('id')
      .single()

    if (claimErr || !claimed) continue

    console.log(`[command/next] delivering prompt to session ${agent.session_id} harness=${agent.harness ?? 'claude-code'}`)
    return res.json({
      prompt:     cmd.prompt,
      sessionId:  agent.session_id,
      sessionCwd: agent.cwd,
      harness:    agent.harness ?? 'claude-code',
    })
  }

  res.json(null)
})

// ── Terminal events ───────────────────────────────────────────────────────────

// GET /mobile/terminal?session_id=xxx&limit=60
router.get('/terminal', requireMachineAuth, async (req, res) => {
  const { session_id, limit = 60 } = req.query

  let query = db
    .from('terminal_events')
    .select('*')
    .eq('user_id', req.machine.user_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit), 200))

  if (session_id) query = query.eq('session_id', session_id)

  const { data, error } = await query

  if (error) {
    console.error('[mobile/terminal]', error.message)
    return res.status(500).json({ error: 'Failed to fetch terminal events' })
  }

  res.json({ events: (data ?? []).reverse() })
})

// ── File browser ──────────────────────────────────────────────────────────────

// POST /mobile/fs/request — ask the desktop to build a file tree
router.post('/fs/request', requireMachineAuth, async (req, res) => {
  const { path = '.', sessionId } = req.body

  // Resolve target machine from session (may be different from calling machine)
  let targetMachineId = req.machine.id
  if (sessionId) {
    const { data: agent } = await db
      .from('agents')
      .select('machine_id, machines(user_id)')
      .eq('session_id', sessionId)
      .single()

    if (agent && agent.machines?.user_id === req.machine.user_id) {
      targetMachineId = agent.machine_id
    }
  }

  const { data, error } = await db
    .from('fs_requests')
    .insert({
      machine_id: targetMachineId,
      session_id: sessionId ?? null,
      path,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[mobile/fs/request]', error.message)
    return res.status(500).json({ error: 'Failed to create fs request' })
  }

  res.json({ requestId: data.id })
})

// GET /mobile/fs/result/:requestId — poll until status = 'ready' | 'error'
router.get('/fs/result/:requestId', requireMachineAuth, async (req, res) => {
  const { data: machines } = await db
    .from('machines')
    .select('id')
    .eq('user_id', req.machine.user_id)

  const machineIds = (machines ?? []).map(m => m.id)
  if (!machineIds.length) return res.status(404).json({ error: 'Request not found' })

  const { data, error } = await db
    .from('fs_requests')
    .select('status, result, error')
    .eq('id', req.params.requestId)
    .in('machine_id', machineIds)
    .single()

  if (error || !data) {
    return res.status(404).json({ error: 'Request not found' })
  }

  res.json(data)
})

export default router
