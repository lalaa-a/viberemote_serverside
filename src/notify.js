import admin from 'firebase-admin'
import { db } from './supabase.js'

let app     = null
let initErr = null

// Initialise Firebase Admin once on first use.
// Logs clearly if anything is wrong so failures are never silent.
function getApp() {
  if (app)     return app
  if (initErr) return null          // already failed — don't retry

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) {
    initErr = 'FIREBASE_SERVICE_ACCOUNT env var is not set'
    console.error('[notify]', initErr)
    return null
  }

  let serviceAccount
  try {
    serviceAccount = JSON.parse(raw)
  } catch (err) {
    initErr = `FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${err.message}`
    console.error('[notify]', initErr)
    return null
  }

  // The private_key in the .env file may have literal \n instead of real
  // newlines (common when copy-pasting JSON into a .env file).
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n')
  }

  try {
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    })
    console.log('[notify] Firebase Admin initialised for project:', serviceAccount.project_id)
  } catch (err) {
    initErr = err.message
    console.error('[notify] Firebase Admin init failed:', err.message)
    return null
  }

  return app
}

// Send a push notification to every FCM token registered for the user.
// Called from /relay/upload — fire-and-forget, never blocks the response.
export async function notifyUser(userId, { title, body, requestId }) {
  if (!getApp()) return

  const { data: rows, error } = await db
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId)

  if (error) {
    console.error('[notify] Failed to fetch push tokens:', error.message)
    return
  }

  if (!rows?.length) {
    console.log('[notify] No push tokens registered for user', userId)
    return
  }

  const tokens = rows.map(r => r.token)

  const message = {
    notification: { title, body },
    data:         { requestId: requestId ?? '' },
    android: {
      priority:     'high',
      notification: { channelId: 'agent-requests', sound: 'default' },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1 } },
    },
    tokens,
  }

  try {
    const response = await admin.messaging().sendEachForMulticast(message)
    const succeeded = response.responses.filter(r => r.success).length
    console.log(`[notify] Sent ${succeeded}/${tokens.length} notifications for request ${requestId}`)

    // Remove tokens that are no longer valid
    const stale = response.responses
      .map((r, i) => (!r.success && r.error?.code === 'messaging/registration-token-not-registered') ? tokens[i] : null)
      .filter(Boolean)

    if (stale.length) {
      console.log('[notify] Removing', stale.length, 'stale token(s)')
      await db.from('push_tokens').delete().in('token', stale)
    }
  } catch (err) {
    console.error('[notify] FCM sendEachForMulticast failed:', err.message)
  }
}
