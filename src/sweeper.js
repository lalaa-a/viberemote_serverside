// sweeper.js — synthesize a turn-end for sessions abandoned mid-turn by a disconnected desktop.
//
// Problem (see STALE_WORKING_ON_DISCONNECT_DESIGN.md §3-B): if the desktop loses its
// connection while a turn is running, the turn-end `stop` event never reaches us, so the feed
// keeps a dangling `active` boundary and the mobile shows "working" forever.
//
// The desktop keepalive stops touching `last_activity_at` on disconnect, so `deriveStatus`
// already decays the session to idle within 30s and the machine goes offline within 90s. This
// sweeper makes the FEED consistent with that: for a session whose machine is OFFLINE and
// whose newest feed event isn't already a `stop`, it inserts a labelled synthetic turn-end and
// broadcasts it, so the chat, session list and composer all agree.
//
// Gated on the machine being OFFLINE (not merely stale activity) on purpose: a still-connected
// machine running a long single tool can have stale `last_activity_at` too, and we must NOT
// falsely end that. Machine-offline is the unambiguous "desktop is gone" signal.
import { db } from './supabase.js'
import { broadcastSession } from './realtime.js'

const TICK_MS          = 45_000
const ACTIVE_WINDOW_MS = 30_000        // matches deriveStatus: < 30s = 'active'
const IDLE_FLOOR_MS    = 10 * 60_000   // matches deriveStatus: > 10min = 'finished' (too old to bother)
const OFFLINE_MS       = 90_000        // matches ONLINE_THRESHOLD_MS in routes/mobile.js

async function sweepOnce() {
  const now = Date.now()

  // Candidates: recently went stale (activity 30s–10min ago) AND the machine is now offline.
  const { data: agents, error } = await db
    .from('agents')
    .select('machine_id, session_id, machines!inner(user_id, last_seen)')
    .lt('last_activity_at', new Date(now - ACTIVE_WINDOW_MS).toISOString())
    .gt('last_activity_at', new Date(now - IDLE_FLOOR_MS).toISOString())
    .lt('machines.last_seen', new Date(now - OFFLINE_MS).toISOString())

  if (error) { console.error('[sweeper] query', error.message); return }
  if (!agents?.length) return

  for (const a of agents) {
    if (!a.session_id) continue

    // Only close a session that was genuinely MID-TURN: its newest feed event must exist and
    // must not already be a `stop` (a clean end, or one we synthesized on a previous tick).
    const { data: last } = await db
      .from('terminal_events')
      .select('event_type')
      .eq('session_id', a.session_id)
      .order('created_at', { ascending: false })
      .limit(1)

    if (!last?.length || last[0].event_type === 'stop') continue

    const { error: insErr } = await db.from('terminal_events').insert({
      session_id: a.session_id,
      machine_id: a.machine_id,
      user_id:    a.machines.user_id,
      event_type: 'stop',
      harness:    'claude-code',
      tool_name:  null,
      summary:    'Connection to the machine was lost — turn state unknown.',
      detail:     null,
      status:     'stopped',
    })
    if (insErr) { console.error('[sweeper] insert', insErr.message); continue }

    broadcastSession(a.session_id, 'feed')
    console.log(`[sweeper] synthesized turn-end for stale session ${a.session_id}`)
  }
}

export function startStaleSweeper() {
  setInterval(() => { sweepOnce().catch(err => console.error('[sweeper]', err.message)) }, TICK_MS)
  console.log('[sweeper] stale-turn sweeper started')
}
