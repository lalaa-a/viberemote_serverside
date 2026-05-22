import { Router } from 'express'
import { db } from '../supabase.js'
import { requireUserAuth, requireMachineAuth } from '../middleware/auth.js'

const router = Router()

// POST /machines/register
// Desktop app calls this after user signs in, on first run (no .env yet)
router.post('/register', requireUserAuth, async (req, res) => {
  const { machineId, machineLabel, apiKeyHash } = req.body

  if (!machineId || !machineLabel || !apiKeyHash) {
    return res.status(400).json({ error: 'machineId, machineLabel and apiKeyHash are required' })
  }

  const { data: existing } = await db
    .from('machines')
    .select('id')
    .eq('id', machineId)
    .single()

  if (existing) {
    return res.status(409).json({ error: 'Machine already registered' })
  }

  const { error } = await db.from('machines').insert({
    id:           machineId,
    user_id:      req.user.id,
    label:        machineLabel,
    api_key_hash: apiKeyHash,
    is_online:    true,
    last_seen:    new Date().toISOString(),
  })

  if (error) {
    console.error('[machines/register]', error.message)
    return res.status(500).json({ error: 'Registration failed' })
  }

  res.json({ ok: true, machineId })
})

// POST /machines/heartbeat
// Relay daemon calls this every 30s to mark the machine as online
router.post('/heartbeat', requireMachineAuth, async (req, res) => {
  const { error } = await db
    .from('machines')
    .update({ is_online: true, last_seen: new Date().toISOString() })
    .eq('id', req.machine.id)

  if (error) {
    console.error('[machines/heartbeat]', error.message)
    return res.status(500).json({ error: 'Heartbeat failed' })
  }

  res.json({ ok: true })
})

// POST /machines/offline
// Relay daemon calls this on clean shutdown
router.post('/offline', requireMachineAuth, async (req, res) => {
  await db
    .from('machines')
    .update({ is_online: false })
    .eq('id', req.machine.id)

  res.json({ ok: true })
})

// ── File tree ─────────────────────────────────────────────────────────────────

// GET /machines/fs/pending — heartbeat polls this every 5s for file tree jobs
router.get('/fs/pending', requireMachineAuth, async (req, res) => {
  const { data, error } = await db
    .from('fs_requests')
    .select('*')
    .eq('machine_id', req.machine.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[machines/fs/pending]', error.message)
    return res.status(500).json({ error: 'Failed to fetch fs request' })
  }

  if (!data) return res.json(null)

  // Attach sessionCwd so heartbeat knows which directory to scan
  let sessionCwd = null
  if (data.session_id) {
    const { data: agent } = await db
      .from('agents')
      .select('cwd')
      .eq('session_id', data.session_id)
      .single()
    sessionCwd = agent?.cwd ?? null
  }

  res.json({ ...data, sessionCwd })
})

// POST /machines/fs/respond — heartbeat posts the completed tree (or error)
router.post('/fs/respond', requireMachineAuth, async (req, res) => {
  const { requestId, tree, error: treeError } = req.body

  if (!requestId) {
    return res.status(400).json({ error: 'requestId is required' })
  }

  const { error } = await db
    .from('fs_requests')
    .update({
      status:      treeError ? 'error' : 'ready',
      result:      tree      ?? null,
      error:       treeError ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('machine_id', req.machine.id)

  if (error) {
    console.error('[machines/fs/respond]', error.message)
    return res.status(500).json({ error: 'Failed to store fs result' })
  }

  res.json({ ok: true })
})

// ── User-authenticated machine management ─────────────────────────────────────

// GET /machines/mine — list all machines for the signed-in user
router.get('/mine', requireUserAuth, async (req, res) => {
  const { data, error } = await db
    .from('machines')
    .select('id, label, is_online, last_seen, created_at')
    .eq('user_id', req.user.id)
    .order('last_seen', { ascending: false, nullsFirst: false })

  if (error) {
    console.error('[machines/mine]', error.message)
    return res.status(500).json({ error: 'Failed to fetch machines' })
  }

  const now = Date.now()
  res.json((data ?? []).map(m => ({
    ...m,
    is_online: m.last_seen
      ? (now - new Date(m.last_seen).getTime()) < 90_000
      : false,
  })))
})

// POST /machines/:machineId/reclaim — re-key an existing machine after reinstall
// Client generates rawKey/apiKeyHash (same pattern as /register) — server only stores the hash
router.post('/:machineId/reclaim', requireUserAuth, async (req, res) => {
  const { machineId } = req.params
  const { apiKeyHash, machineLabel } = req.body

  if (!apiKeyHash) return res.status(400).json({ error: 'apiKeyHash is required' })

  const { data: machine, error: fetchErr } = await db
    .from('machines')
    .select('id, user_id')
    .eq('id', machineId)
    .single()

  if (fetchErr || !machine) return res.status(404).json({ error: 'Machine not found' })
  if (machine.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })

  const update = { api_key_hash: apiKeyHash, is_online: false, last_seen: null }
  if (machineLabel) update.label = machineLabel

  const { error: updateErr } = await db
    .from('machines')
    .update(update)
    .eq('id', machineId)

  if (updateErr) {
    console.error('[machines/reclaim]', updateErr.message)
    return res.status(500).json({ error: 'Reclaim failed' })
  }

  res.json({ ok: true })
})

// DELETE /machines/:machineId — remove a ghost machine from the account
router.delete('/:machineId', requireUserAuth, async (req, res) => {
  const { data: machine } = await db
    .from('machines')
    .select('user_id')
    .eq('id', req.params.machineId)
    .single()

  if (!machine || machine.user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' })

  const { error } = await db
    .from('machines')
    .delete()
    .eq('id', req.params.machineId)

  if (error) {
    console.error('[machines/delete]', error.message)
    return res.status(500).json({ error: 'Delete failed — machine may have linked data' })
  }

  res.json({ ok: true })
})

export default router
