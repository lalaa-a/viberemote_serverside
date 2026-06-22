import { Router } from 'express'
import { db } from '../supabase.js'
import { requireMachineAuth } from '../middleware/auth.js'
import { syncAgentPendingCount } from '../utils.js'
import { notifyMachine } from '../notify.js'
import { broadcastSession } from '../realtime.js'

const router = Router()

// POST /relay/sessions-alive
// Called by the heartbeat every ~15s with the session IDs whose harness CLI is
// still running on this machine. We mark those agents cli_alive=true and every
// other agent on the machine cli_alive=false (their CLI was closed). Mobile reads
// cli_alive to block prompting a closed session.
router.post('/sessions-alive', requireMachineAuth, async (req, res) => {
  const ids = Array.isArray(req.body.aliveSessionIds)
    ? req.body.aliveSessionIds.filter(s => typeof s === 'string' && s.length)
    : []

  // Mark the live ones alive
  if (ids.length) {
    await db.from('agents')
      .update({ cli_alive: true })
      .eq('machine_id', req.machine.id)
      .in('session_id', ids)
  }

  // Mark everything else on this machine as closed
  let dead = db.from('agents')
    .update({ cli_alive: false })
    .eq('machine_id', req.machine.id)
    .eq('cli_alive', true)
  if (ids.length) {
    // PostgREST "not in" list — session IDs are uuids / ses_* (no special chars)
    dead = dead.not('session_id', 'in', `(${ids.join(',')})`)
  }
  const { error } = await dead
  if (error) {
    console.error('[relay/sessions-alive]', error.message)
    return res.status(500).json({ error: error.message })
  }

  res.json({ ok: true })
})

// POST /relay/agent-ping
// Called by hook.js on every tool call to upsert the agent row and refresh last_activity_at
router.post('/agent-ping', requireMachineAuth, async (req, res) => {
  const { sessionId, cwd, harness } = req.body

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' })
  }

  const { data, error } = await db
    .from('agents')
    .upsert(
      {
        session_id:       sessionId,
        machine_id:       req.machine.id,
        cwd:              cwd || null,
        harness:          harness ?? 'claude-code',
        cli_alive:        true,   // a session that just acted is definitely open
        last_activity_at: new Date().toISOString(),
      },
      { onConflict: 'session_id' }
    )
    .select('id')
    .single()

  if (error) {
    console.error('[relay/agent-ping]', error.message)
    return res.status(500).json({ error: 'Agent ping failed' })
  }

  res.json({ agentId: data.id })
})

// POST /relay/upload
// Called by hook.js when Claude Code fires a tool-use event
router.post('/upload', requireMachineAuth, async (req, res) => {
  const { payload } = req.body

  if (!payload) {
    return res.status(400).json({ error: 'payload is required' })
  }

  // Resolve agent_id from session_id so the request is linked to the session
  let agentId = null
  if (payload.session_id) {
    const { data: agent } = await db
      .from('agents')
      .select('id')
      .eq('session_id', payload.session_id)
      .single()
    agentId = agent?.id ?? null
  }

  const { data, error } = await db
    .from('pending_requests')
    .insert({
      ...payload,
      harness:    payload.harness ?? 'claude-code',
      agent_id:   agentId,
      machine_id: req.machine.id,
      user_id:    req.machine.user_id,
      status:     'pending',
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    console.error('[relay/upload]', error.message)
    return res.status(500).json({ error: 'Upload failed' })
  }

  await syncAgentPendingCount(agentId)

  // Nudge any open chat so the new request card streams in live (not on the 30s poll)
  broadcastSession(payload.session_id, 'feed')

  // Fire-and-forget: notify only the phone paired to this machine
  notifyMachine(req.machine.id, {
    title:     `${payload.tool_name} needs approval`,
    body:      payload.summary ?? 'A tool-use request is waiting',
    requestId: data.id,
  })

  res.json({ id: data.id })
})

// POST /relay/decide
// Called by relay.cjs when the PC terminal approves or denies a request
router.post('/decide', requireMachineAuth, async (req, res) => {
  const { requestId, decision } = req.body

  if (!requestId || !decision) {
    return res.status(400).json({ error: 'requestId and decision are required' })
  }
  if (!['approved', 'denied'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or denied' })
  }

  // Fetch agent_id + session_id first so we can sync count and nudge the chat
  const { data: reqRow } = await db
    .from('pending_requests')
    .select('agent_id, session_id')
    .eq('id', requestId)
    .eq('machine_id', req.machine.id)
    .single()

  const { error } = await db
    .from('pending_requests')
    .update({
      status:     decision,
      decided_at: new Date().toISOString(),
      decided_by: 'pc',
    })
    .eq('id', requestId)
    .eq('machine_id', req.machine.id)
    .eq('status', 'pending')

  if (error) {
    console.error('[relay/decide]', error.message)
    return res.status(500).json({ error: 'Decision update failed' })
  }

  await syncAgentPendingCount(reqRow?.agent_id)

  // Nudge any open chat so the card flips to approved/denied live
  broadcastSession(reqRow?.session_id, 'feed')

  res.json({ ok: true })
})

// POST /relay/terminal-event
// Called by postHook.js, notifyHook.js, stopHook.js on the desktop
router.post('/terminal-event', requireMachineAuth, async (req, res) => {
  const { session_id, event_type, tool_name, summary, detail, status } = req.body

  if (!session_id || !event_type) {
    return res.status(400).json({ error: 'session_id and event_type are required' })
  }

  const { error } = await db
    .from('terminal_events')
    .insert({
      session_id,
      machine_id: req.machine.id,
      user_id:    req.machine.user_id,
      event_type,
      harness:    req.body.harness ?? 'claude-code',
      tool_name:  tool_name ?? null,
      summary:    summary   ?? null,
      detail:     detail    ?? null,
      status:     status    ?? null,
    })

  if (error) {
    console.error('[relay/terminal-event]', error.message)
    return res.status(500).json({ error: error.message })
  }

  // Nudge any open chat so new reasoning/activity streams in live
  broadcastSession(session_id, 'feed')

  res.json({ ok: true })
})

// GET /relay/status/:requestId
// Polling fallback — relay daemon polls this if Realtime is unavailable
router.get('/status/:requestId', requireMachineAuth, async (req, res) => {
  const { data, error } = await db
    .from('pending_requests')
    .select('status, decided_by, decided_at')
    .eq('id', req.params.requestId)
    .eq('machine_id', req.machine.id)
    .single()

  if (error || !data) {
    return res.status(404).json({ error: 'Request not found' })
  }

  res.json(data)
})

export default router
