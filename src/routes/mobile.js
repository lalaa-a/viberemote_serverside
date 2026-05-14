import { Router } from 'express'
import { db } from '../supabase.js'
import { requireMachineAuth } from '../middleware/auth.js'

const router = Router()

// GET /mobile/machine — verify credentials (auth middleware already did the DB lookup)
router.get('/machine', requireMachineAuth, (req, res) => {
  res.json(req.machine)
})

// GET /mobile/requests — pending requests for this machine
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

  res.json({ ok: true })
})

// GET /mobile/machines — list all machines for this user (via machine's user_id)
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

  res.json(data ?? [])
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

export default router
