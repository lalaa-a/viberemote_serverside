import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rateLimit } from 'express-rate-limit'
import machinesRouter from './routes/machines.js'
import relayRouter from './routes/relay.js'
import mobileRouter from './routes/mobile.js'
import harnessRouter from './routes/harness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app  = express()
const PORT = process.env.PORT || 3000

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors())
app.use(express.json({ limit: '2mb' }))

// Rate limiting — protects against brute-force on machine API key and auth
const limiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 120,              // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
})
app.use(limiter)

// Stricter limit on machine registration (one-time operation)
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts' },
})

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

// Landing page GoTrue redirects to after a user clicks the email confirmation link
// (SITE_URL=https://insight25.lk/confirmed in the Supabase .env points here)
app.get('/confirmed', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/confirmed.html'))
})

app.use('/machines', machinesRouter)
app.use('/relay', relayRouter)
app.use('/mobile', mobileRouter)
app.use('/harness', harnessRouter)

// Apply strict limiter only to the register endpoint
app.use('/machines/register', registerLimiter)

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Vibe Remote API listening on port ${PORT}`)
  console.log(`Supabase project: ${process.env.SUPABASE_URL}`)
})
