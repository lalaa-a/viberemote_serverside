// Server → client push over Supabase Realtime *broadcast*.
//
// We use the HTTP broadcast endpoint (not a persistent WebSocket) so an Express
// handler can fire an event statelessly and return immediately. Broadcast does NOT
// go through table RLS, which is exactly what we need: the desktop has no user
// session, and the most important event (`paired`) happens while the machine is
// still unowned — so postgres_changes + owner-RLS could never deliver it.
//
// The channel name carries the machine UUID (`machine:<id>`); the desktop subscribes
// to that topic. Payloads are intentionally empty — the desktop re-fetches
// GET /machines/:id/session (machine-key authed) on any event, so no token or
// device data ever rides the unauthenticated broadcast channel.

const BROADCAST_URL = `${process.env.SUPABASE_URL}/realtime/v1/api/broadcast`

export function broadcastMachine(machineId, event, payload = {}) {
  // Fire-and-forget: a realtime hiccup must never fail or delay the HTTP handler.
  // The desktop's session poll is the correctness backstop if this never lands.
  fetch(BROADCAST_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey:         process.env.SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      messages: [{ topic: `machine:${machineId}`, event, payload }],
    }),
  }).catch(() => {})
}
