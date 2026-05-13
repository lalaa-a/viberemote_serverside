import { Router } from 'express'
import { db } from '../supabase.js'
import { requireMachineAuth } from '../middleware/auth.js'

const router = Router()

// POST /relay/upload
// Called by hook.js when Claude Code fires a tool-use event
// Body: { payload: { tool_name, display_type, summary, risk_level, ... } }
router.post('/upload', requireMachineAuth, async (req, res) => {
  const { payload } = req.body

  if (!payload) {
    return res.status(400).json({ error: 'payload is required' })
  }

  const { data, error } = await db
    .from('pending_requests')
    .insert({
      ...payload,
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

  res.json({ id: data.id })
})

// POST /relay/decide
// Called by relay.cjs when PC terminal approves or denies a request
// Body: { requestId, decision: 'approved'|'denied' }
router.post('/decide', requireMachineAuth, async (req, res) => {
  const { requestId, decision } = req.body

  if (!requestId || !decision) {
    return res.status(400).json({ error: 'requestId and decision are required' })
  }
  if (!['approved', 'denied'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or denied' })
  }

  const { error } = await db
    .from('pending_requests')
    .update({
      status:      decision,
      decided_at:  new Date().toISOString(),
      decided_by:  'pc',
    })
    .eq('id', requestId)
    .eq('machine_id', req.machine.id)
    .eq('status', 'pending')

  if (error) {
    console.error('[relay/decide]', error.message)
    return res.status(500).json({ error: 'Decision update failed' })
  }

  res.json({ ok: true })
})

// GET /relay/status/:requestId
// Polling fallback — relay daemon can poll this instead of Realtime if needed
router.get('/status/:requestId', requireMachineAuth, async (req, res) => {
  const { requestId } = req.params

  const { data, error } = await db
    .from('pending_requests')
    .select('status, decided_by, decided_at')
    .eq('id', requestId)
    .eq('machine_id', req.machine.id)
    .single()

  if (error || !data) {
    return res.status(404).json({ error: 'Request not found' })
  }

  res.json(data)
})

export default router
