import { Router } from 'express'
import { db } from '../supabase.js'
import { requireUserAuth, requireMachineAuth } from '../middleware/auth.js'

const router = Router()

// POST /machines/register
// Desktop app calls this after user signs in, on first run (no .env yet)
// Body: { machineId, machineLabel, apiKeyHash }
router.post('/register', requireUserAuth, async (req, res) => {
  const { machineId, machineLabel, apiKeyHash } = req.body

  if (!machineId || !machineLabel || !apiKeyHash) {
    return res.status(400).json({ error: 'machineId, machineLabel and apiKeyHash are required' })
  }

  // Check this machine isn't already registered
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
// Relay daemon calls this periodically to mark the machine as online
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

export default router
