import { createHash } from 'node:crypto'
import { authClient, db } from '../supabase.js'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

// Validates Supabase Auth JWT — used for routes the desktop/mobile app calls
export async function requireUserAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' })
  }

  const token = header.slice(7)
  const { data: { user }, error } = await authClient.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  req.user = user
  next()
}

// Validates machine API key — used for routes the relay daemon calls
export async function requireMachineAuth(req, res, next) {
  const apiKey = req.headers['x-machine-api-key']
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-machine-api-key header' })
  }

  const hash = sha256(apiKey)
  const { data: machine, error } = await db
    .from('machines')
    .select('id, user_id, label')
    .eq('api_key_hash', hash)
    .single()

  if (error || !machine) {
    return res.status(401).json({ error: 'Invalid machine API key' })
  }

  req.machine = machine
  next()
}
