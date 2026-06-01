Good — index.js needs no changes. All routes are already wired in.

  ---
  Server changes — done

  New file: src/utils.js
  
  - syncAgentPendingCount(agentId) — counts actual pending rows for an agent and writes the result back. Called after every upload and decide so pending_count is always
  accurate.
  - deriveStatus(lastActivityAt) — computes active / idle / finished from the timestamp at query time; never stored.

  relay.js — 3 changes

  ┌──────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │           Endpoint           │                                                     What changed                                                     │
  ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ POST /relay/agent-ping (new) │ Upserts agent row on every hook call; sets session_id, machine_id, cwd, last_activity_at. Returns { agentId }.       │
  ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ POST /relay/upload (updated) │ Resolves agent_id from session_id before insert, links the request to its session, then calls syncAgentPendingCount. │
  ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ POST /relay/decide (updated) │ Fetches agent_id first, then updates the request, then calls syncAgentPendingCount.                                  │
  └──────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  mobile.js — 11 endpoints (9 new, 2 updated)

  ┌────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │                    Endpoint                    │                                                                                                                       │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ GET /mobile/sessions (new)                     │ All sessions across all user machines with deriveStatus applied.                                                      │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ GET /mobile/sessions/:sessionId/requests (new) │ Pending requests scoped to one session.                                                                               │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ POST /mobile/prompt (new)                      │ Inserts mobile_commands; resolves target machine_id from session_id.                                                  │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ GET /mobile/prompts (new)                      │ Last 20 commands for the user.                                                                                        │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ DELETE /mobile/prompt/:id (new)                │ Sets status to cancelled if still pending.                                                                            │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ GET /mobile/command/next (new)                 │ Idle-gated — returns command only when pending_count=0 AND last_activity_at > 30s ago; atomically marks it delivered. │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ POST /mobile/fs/request (new)                  │ Inserts fs_requests; resolves target machine from session_id.                                                         │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ GET /mobile/fs/result/:requestId (new)         │ Polls the fs_requests row; ownership-checked via user's machines.                                                     │
  ├────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ POST /mobile/decide (updated)                  │ Now calls syncAgentPendingCount after deciding.                                                                       │
  └────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  machines.js — 2 new endpoints

  ┌─────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────┐
  │            Endpoint             │                                                                                   │
  ├─────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
  │ GET /machines/fs/pending (new)  │ Returns oldest pending fs_requests row for this machine + sessionCwd from agents. │
  ├─────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
  │ POST /machines/fs/respond (new) │ Stores tree result or error back into the fs_requests row.                        │
  └─────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────┘

  ---
  Next step is the mobile app — Steps 5, 8, 11, 12: Sessions tab, SessionDetail, PromptCompose, and FileBrowser screens. Ready when you are.