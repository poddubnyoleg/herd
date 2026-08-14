# Proposal: Server-side sessions + Telegram supervisor

Control Herd from an iPhone without exposing anything: sessions become
server-side objects (browser tabs are views), Herd grows an MCP surface, and a
single long-running Claude session ("supervisor") sits on top of it, reachable
via the official Telegram channel plugin. No inbound ports, no VPN, no tunnel.

```
iPhone Telegram ⇄ telegram plugin ⇄ supervisor (claude, channels) ⇄ herd-mcp ⇄ Herd server :3456 ⇄ PTYs
                                                                                ⇧ SSE events        ⇧ attach/detach
                                                                                browser (optional view)
```

## Motivation

- The phone use case ("fire a task, pocket the phone, check back") is broken
  today at the root: `ws.on('close')` SIGHUPs the PTY (`server.js:2125`), and
  iOS drops the WebSocket on every screen lock. Any mobile transport inherits
  this until sessions outlive their viewer.
- Anthropic's Remote Control covers only Claude, only sessions whose process
  opted in, one at a time. Herd's differentiators — all agents (Claude, Codex,
  Gemini, pi), all projects, all history, cross-session orchestration — are
  exactly what it doesn't do.
- Telegram long-polls outbound; the channels/MCP machinery is designed for
  precisely this shape (a channel = MCP server that pushes events into a
  running session; may also expose tools).

**Honest alternative for calibration:** Phases 1–2 + Tailscale on the iPhone
gives the full Herd UI on the phone with zero new services — no bot token, no
supervisor daemon, nothing transiting third-party servers. What Phases 3–4 add
on top is push notification, triage/summarization, and natural-language
control ("continue the sweatcoin session, then run tests"). That is the real
product of this proposal; if it stops being wanted, stop after Phase 2.

## Phase 1 — Server-side session lifecycle

The PTYs already live in the server; the browser never owned them. This phase
changes session lifetime policy and the I/O fan-out. Honest sizing: **~500–700
lines** and the largest phase by some margin. The per-connection closures
(auto-naming buffers, session-id detection, `sessionEnded`, backpressure) all
become per-terminal state with viewer broadcast — but on top of that sit a
client-side attach protocol (snapshot + watermark + writer arbitration), the
`termId`-keyed reconnect that replaces `?resume=`, `saveTabState` changes, and
the Playwright rewrites this phase itself lists. The earlier ~300–400 estimate
counted only the server-side state split.

1. **Extract spawn from the WS handler.** The connection-handler body (agent
   resolution, snapshotKeys, `pty.spawn`, auto-naming, session-id detection)
   becomes `spawnSession(params) → termId`, callable from the WS path and from
   `POST /api/sessions/spawn`. `termId` is generated *before* the launch
   command is built, so it can be baked into hooks (Phase 2).
2. **Detach instead of kill.** Registry:
   `termId → { proc, viewers:Set<ws>, screen, lastOutput, lastInput, state }`.
   WS close removes a viewer; the PTY keeps running.
3. **Screen state, not byte ring.** A raw output ring replayed into a fresh
   xterm starts at an arbitrary cut point — possibly mid-escape-sequence,
   possibly after an alt-screen switch — and paints garbage. Instead the
   server holds a headless terminal (`@xterm/headless` + SerializeAddon) per
   PTY; on attach the client receives a serialized snapshot (screen +
   scrollback), then the live stream. Two things this does *not* give for
   free, both to settle in the spike: SerializeAddon captures the **active**
   buffer, not the alt-screen *mode*, so a viewer attaching while the agent
   sits in a pager/`vim`/full-screen dialog gets alt-screen contents painted
   into a terminal that isn't in alt mode — and the eventual DECRST 1049
   restores a buffer it never had. Either replay the mode explicitly or
   refuse-and-retry the snapshot while in alt screen. The headless terminal
   also **owns terminal query replies**: a detached TUI issuing DA/DSR or
   similar expects an emulator to answer, and with no viewer it hangs — while
   after attach, headless *and* browser xterm would both answer and send
   duplicates. The headless instance is the canonical responder; client-side
   protocol replies must be suppressed on attached viewers. And attach needs a
   **sequence watermark**: capture-then-subscribe drops output produced in
   between, subscribe-then-capture delivers live bytes ahead of the snapshot.
   Snapshot carries `seq`; the client discards streamed frames at or below it.
4. **Attach on `termId`, not on session id.** The current same-session
   takeover (`server.js:1821`) becomes "add viewer". The attach handle is
   `termId`, already sent in the `ready` message (`server.js:1875`) — *not*
   `?resume=<sessionId>`. This matters: for a **new** session `sessionId`
   stays null until detection lands, up to `SESSION_DETECT_DEADLINE` = 5 min
   (`server.js:2047`), so a lock keyed `(agent, sessionId)` is vacuous exactly
   during the window a phone drops its socket — and the client couldn't
   reattach anyway, since `saveTabState` filters tabs on `t.sessionId`
   (`app.js:262`). Both change: client persists `termId` and reconnects
   `?attach=<termId>`; `saveTabState` keys on it. The `(agent, sessionId)`
   spawn lock still applies to the *resume* path, so two racing clients can't
   both spawn `--resume` against one transcript.
   Two consequences that must land in this phase, not Phase 3. **Persist both
   ids, not just `termId`** — `termId` dies with the server, which this
   document names the dominant remaining loss event, so a `termId`-only
   `saveTabState` leaves nothing to `--resume` from after a restart. Fallback
   chain: `?attach=<termId>` → on `unknown-term`, respawn via
   `?resume=<sessionId>` → if `sessionId` is null, the tab is genuinely lost.
   And **Phase 1 needs its own `GET /api/live`** plus sidebar entries for
   live-but-unknown terminals: otherwise the only handle to a detached PTY is a
   `termId` in one browser's `localStorage`, so clearing site data, switching
   browser, or opening from a second device leaves running PTYs invisible and
   reclaimable only by the 24 h backstop. `list_live` is Phase 3 and MCP-only;
   without the REST sibling, Phase 1's standalone value claim doesn't hold.
5. **Multi-viewer needs an owner, for input and for geometry.** Two viewers
   (or a viewer and herd-mcp) writing to one PTY interleave keystrokes into
   corrupted commands, and one headless terminal cannot render two window
   sizes: "last attacher wins" reflows the shared buffer and SIGWINCHes the
   agent under everyone else. Policy: exactly one **writer** at a time
   (attach requests it, others are read-only until they steal it explicitly),
   and geometry is pinned to the writer — other viewers letterbox and get a
   forced re-snapshot on every size change. The headless terminal must be
   resized in lockstep with every `proc.resize()`, *not* pinned at a constant:
   the 96-col cap is applied once at launch via `stty cols`
   (`server.js:1881-1887`) while the resize path forwards client cols uncapped
   (`server.js:2120`), so the PTY's real width already tracks the writer's
   window. A headless instance frozen at 96×30 would serialize every snapshot
   reflowed at the wrong width — exactly the garbage 1.3 exists to prevent.
   Stated precisely, because it reads as an endorsement otherwise: the 96-col
   cap is *deliberate* (see CLAUDE.md) and is currently **defeated** by the
   first client resize, which fires within a frame of connect. That is a bug to
   decide about separately. The lockstep requirement holds either way, since it
   follows whatever `proc.resize()` actually does.
6. **Backpressure per viewer — keep the pause, add a floor.** Today the PTY
   pauses on the sole socket's `bufferedAmount` (`server.js:2070`). New
   policy: a slow viewer no longer stalls the PTY on its own — it gets
   dropped from the stream and resynced. But flow control does not simply go
   away, for two reasons. A dropped viewer resynced from screen **+
   scrollback** receives more bytes than the stream that just overflowed it,
   so naive resync re-overflows immediately: resync sends screen only, no
   scrollback, and rate-limits retries. And with zero viewers the headless
   terminal still parses every byte on the one event loop that serves the UI,
   SSE, and every other terminal — a runaway `yes`/build/log tail is now a
   server-wide problem, so keep `proc.pause()` on a headless-side high-water
   mark too.
7. **Attach must carry turn state.** The client's input gate assumes a
   (re)connect lands at a prompt (`app.js:971` — "it cannot be doing work"),
   which becomes false when attaching to a mid-turn headless session; the
   attach reply includes the server's known state (mid-turn / idle) so the
   green-pulse logic doesn't require local user input first.
8. **UI semantics.** The tab ✕ becomes detach; killing needs a *second*
   gesture, since ✕ is the only close affordance today — shift-click the ✕, or
   a sidebar "kill session" action. Sidebar shows live-PTY state (running /
   idle / detached). `beforeunload` warning goes away. Note the semantics being
   inverted here have **no test coverage today**: `test/hub.test.mjs:497`
   asserts only that the DOM tab count drops, and stays green under detach;
   nothing in the suite asserts the PTY dies on close. Detach-vs-kill tests are
   new work in this phase, not edits to existing ones.
9. **Interim GC.** The real reaper needs Phase 2's turn signal (see below).
   Until then: manual kill + a conservative backstop (reap detached PTYs after
   24 h). Phases 1–2 should land together or near-together for this reason —
   "ships independently" holds for the attach/detach value, not for GC. Keep
   the 24 h backstop permanently as a floor: if the turn signal ever fails to
   arrive, the 12 h reaper below never fires (it requires `turn-ended`) and
   PTYs accumulate unbounded. Note the floor must therefore sit *above* the
   reaper's own window — 24 h backstop, 12 h reaper — so the backstop is a
   genuine last resort rather than the rule that does the reaping.

Side effects for free: browser reload, Chrome Memory Saver discard, iOS screen
lock, and the lid-close SIGHUP cascade (green-tabs saga) stop killing
sessions. The proximate killer in that cascade is Herd's own 30 s WS heartbeat
(`server.js:111-120`) terminating sockets that stopped ponging, which fires
`ws.on('close')` — so it is squarely inside what this phase changes.

**Sessions still die with the server, and this phase does not change that.**
`cleanup()` SIGHUPs every registered terminal on SIGINT/SIGTERM
(`server.js:2136-2141`) and `terminals` is an in-memory Map, so even orphaned
PTYs would be unreachable. Every `npm start`, deploy, and crash mass-kills
sessions that Phase 1 otherwise makes durable — on a repo under daily edit
that is the *dominant* remaining loss event, and Phase 4 assumes nightly
restarts besides. Accepted as a limit, not solved: recovery is the same as
after a reap (transcripts on disk + `--resume`), and the honest framing is
"sessions outlive their viewer," not "sessions are persistent objects."
Reparenting PTYs to tmux/dtach per session would fix it and is out of scope.
Related caveat, unchanged: sleep still severs the in-flight API call inside
the agent — sessions survive, the interrupted turn does not.

## Phase 2 — Server-side turn state + reaper (~200 lines)

Green-tab logic lives in `public/app.js` today; headless sessions have no
client to run it.

- **Claude: verified working.** Inject `Stop` and `Notification` hooks via the
  `--settings` JSON Herd already passes at launch (`server.js:563`). Hooks
  receive JSON on **stdin**. Tested end-to-end with `{"sandbox":{"enabled":
  true}}` and the hooks in the *same* JSON: the hook fires, gets its payload
  on stdin, and its loopback POST is **not** blocked by the sandbox. (This
  retires what was risk 7.) The command, quoted — an unquoted `&` would
  background `curl` mid-URL and `?` is a zsh glob — and with the token read
  at exec time rather than baked into argv (see Phase 3):

  ```
  curl -sS -X POST --config ~/.herd/curl-auth --data-binary @- \
    "http://127.0.0.1:<port>/api/internal/turn-ended?termId=<termId>"
  ```

  `--config` against a 0600 file holding one
  `header = "Authorization: Bearer <token>"` line, **not**
  `-H "Authorization: Bearer $(cat …)"`: command substitution is expanded by
  the shell *before* `curl` is exec'd, so that form puts the plaintext token
  into `curl`'s own argv — which `ps -ax -o args=` exposes across uids on this
  machine, the one caller class the token exists to exclude. Never a query
  string either.

  `termId` is the key, not the session id: it exists pre-launch per Phase 1,
  while session-id detection is async and loses the race with a fast first
  turn. **Bonus that removes work elsewhere:** the hook payload itself carries
  `session_id` and `transcript_path`, so the first `Stop` hands Herd the
  Claude session id directly — the JSONL-polling detection at
  `server.js:2044-2062` and its 5-minute race become a fallback for Claude.
  `Notification` gives Claude a real `needs-attention` event instead of the
  output regex below — but **register it with a matcher**, and **define what
  clears it**. `Notification` fires on a typed set (`permission_prompt`,
  `idle_prompt`, `agent_needs_input`, `auth_success`, `elicitation_*`), and
  `idle_prompt` fires on ~60 s of input idle. Subscribing to all of them would
  set `needs-attention` on *every* detached idle Claude session within a
  minute — precisely the reap target — so `¬needs-attention` would never hold
  and the reaper below would never fire for Claude at all: the phase's headline
  deliverable failing closed. Match `permission_prompt` (plus
  `agent_needs_input` / `elicitation_dialog`) and let idle notifications go
  nowhere. The matcher is a structured discriminator; do not parse the
  `message` string. Clearing is equally load-bearing and equally absent
  otherwise: `UserPromptSubmit` (payload carries `user_input`), any
  `send_input`, or any viewer keystroke clears the flag; `Stop` alone does not,
  since a prompt answered mid-turn produces no `Stop` until the turn ends.
- **Codex / Gemini / pi:** output-idle heuristic server-side (server already
  sees all PTY output): N s of quiet after output, gated on input having been
  sent since attach (mirrors the green-tabs input-gate lesson). A CLI-supplied
  `initial_prompt` (Phase 3) **counts as input and arms the gate** — without
  that, a supervisor-started session never sends a keystroke, the gate never
  opens, and it emits no `turn-ended` at all: no triage and no reap, for
  exactly the sessions the supervisor created. Weaker than it sounds even so —
  a silent tool call or slow network request is indistinguishable from a
  finished turn, so for these agents "turn-ended" means "probably idle," and
  the reaper must treat it as such.
- **Blocked ≠ idle ≠ done, and detection failure is not fail-safe.** A session
  waiting on a permission prompt is output-quiet indefinitely, for *all*
  agents. Two failure modes the earlier draft of this document got backwards:
  suppression requires *detection*, so a prompt the regex misses is not
  reap-suppressed — it is silently reapable. And Claude's `Stop` fires at the
  end of **every** turn including one that ends by asking the user a plain
  question, which is not a permission-prompt shape and matches no regex. So
  "turn-ended ∧ detached ∧ nothing matched" is simultaneously the reap trigger
  and the exact state of a session waiting for a reply from the phone. The
  reaper below is built around that, because the regex will never be reliable.
- **Reaper — bias hard toward not killing. One tier, not two.** SIGHUP a PTY
  that is detached (zero viewers) ∧ turn-ended ∧ not needs-attention, after
  **12 h**, for every agent, with no fast path. An earlier draft had a 45-minute
  tier for "a Claude session whose `Stop` payload shows a turn that ended
  without a question." That cannot be built: the `Stop` payload carries
  `session_id`, `transcript_path`, `cwd`, `hook_event_name` and
  `stop_hook_active` — no message content. The only available discriminator is
  the regex declared unreliable just above, so the tier would either never fire
  or fire precisely on the false negative, killing the session that is waiting
  for a reply from the phone. (Classifying the last assistant message out of
  `transcript_path` *would* work, and rides on the `read_transcript` reader
  Phase 3 needs anyway — deliberately deferred until PTY accumulation is
  observed to actually bind.) 45 minutes was in any case shorter than the human
  latency of "fire a task, pocket the phone, check back" that motivates this
  whole document. The real reclamation is the cap: max N live PTYs, reap
  longest-idle first (agent processes are hundreds of MB; RAM is the
  constraint, and RAM pressure is a better reap trigger than a wall clock).
  **The cap carries the same predicate as the tier, not a weaker one.** It is
  the path that actually fires, so its policy *is* the reaper's policy: it must
  also require detached ∧ ¬needs-attention, or it will SIGHUP the session open
  in a browser tab or the one waiting on a permission reply from your phone —
  "longest-idle" is exactly what a blocked session looks like. If every live
  PTY is protected, `start_session` fails loudly rather than evicting. Phase
  4's "cap supervisor-initiated live PTYs (e.g. 5)" is a **sub-quota of N**,
  not a second independent cap.
  Reaping is *near*-lossless: transcripts are on disk and every agent
  resumes, but shell state (background jobs, env) and pre-resume scrollback
  die with the PTY — and resume fidelity for Codex/Gemini/pi needs
  verification (risk 3).
- **Durable events.** `GET /api/session-events` (SSE, sibling of
  `/api/summary-events`): `started`, `turn-ended`, `needs-attention`,
  `attached`, `detached`, `exited`, `reaped` — each stamped `{epoch, seq}` and
  replayable via
  `?since=<epoch>:<seq>` from a small in-memory ring. The epoch is Herd's boot
  id, and it is load-bearing: the ring is in-memory, so a restart both wipes
  history and resets `seq`, and a subscriber's persisted cursor would then
  point at a sequence that never existed. Two branches are mandatory, not
  optional — **epoch mismatch** and **cursor older than the ring** must both
  return `resync-required`, and the subscriber rebuilds from `list_live`
  rather than assuming it missed nothing. Without them "misses nothing" is
  false in exactly the case it is claimed for.

## Phase 3 — herd-mcp (~250 lines, new file)

A stdio MCP server registered in the supervisor project's `.mcp.json`. Dual
capability per the channels reference: `claude/channel` (push) + `tools`.

- **Events:** subscribes to Herd's SSE with a persisted `{epoch, seq}` cursor,
  re-emits as `notifications/claude/channel` with meta `{event, termId,
  sessionId, project, agent}`. Must handle `resync-required` (Herd restarted,
  or the cursor fell off the ring) by rebuilding from `list_live` rather than
  silently receiving nothing. **Watch filter:** by default only *detached*
  sessions' events are forwarded (a session with an open browser tab is being
  watched at the desk — triaging it burns tokens for nothing); `watch_session`
  opts a specific session in. The filter needs the `detached` event to be
  correct: `needs-attention` firing while you watch at the desk is suppressed,
  and closing the lid a minute later produces nothing new — so on `detached`,
  herd-mcp re-evaluates that session's last known state and forwards it then.
  Without it the common "agent hit a prompt, then I walked away" case is never
  reported at all.
- **Tools:**
  - read-only: `list_projects`, `list_sessions(project)`, `list_live()`,
    `read_transcript(sessionId, tail_n)` — note: transcript reading is a
    *new* Herd endpoint built on the existing per-agent JSONL parsers (they
    currently extract metadata/previews, not full message streams). Full
    message readers for four distinct JSONL schemas are **not** inside the
    ~250 lines above; budget them separately.
  - mutating: `start_session(project, agent, initial_prompt?)` (prompt passed
    as a CLI argument to the agent, not typed into the TUI — verify each agent
    actually accepts a positional prompt: `claude "…"` does, the other three
    are unchecked, and having to type it instead would reopen the `send_input`
    gate below for the very first write),
    `resume_session(agent, sessionId)` — the "continue any session"
    requirement, spawns a PTY with `--resume` — `send_input(termId, text)`,
    `kill_session(termId)`.
- **`send_input` gate — liveness is necessary and not sufficient.** The text
  goes into a login shell (`zsh -li`) hosting the agent as a foreground job;
  if the agent exited, the bytes execute as shell commands. **Supervisor-spawned
  sessions therefore `exec` the agent** (see below), which makes this check
  exact rather than heuristic: with no shell to fall back to, agent exit *is*
  PTY exit, so "does this `termId` still exist" is the whole liveness test.
  node-pty's `proc.process` — verified to track the foreground job (`"zsh"`
  idle → `"sleep"` while one runs), and cheaper than spawning
  `ps -o pgid,comm -t <tty>` per call — stays as a secondary check but cannot
  carry the gate alone: it returns the foreground pgrp leader's `comm`, and
  only `claude` is a native binary here. `codex`, `gemini` and `pi` are all
  `#!/usr/bin/env node` shims reporting `node`, indistinguishable from each
  other and from any other node process. Three honest limits, so this is
  presented as best-effort and not as a hard gate:
  - **Alive ≠ accepting free text.** A session sitting on a y/n permission
    prompt or a numbered menu consumes arbitrary text as a *selection* — so
    the supervisor can answer an inner session's permission prompt by
    accident, violating this document's own "never auto-answer `y`" rule with
    no pattern-matching involved. `send_input` must therefore also require
    turn-state `idle` (Phase 2) and refuse while `needs-attention` is set,
    with a separate explicit `answer_prompt` tool if that is ever wanted.
  - **TOCTOU.** The agent can exit between the check and `proc.write`. Same
    class as risk 2; make the check and the write atomic in one tick.
  - **It must acquire the writer lease.** Phase 1.5 establishes exactly one
    writer per PTY; `send_input` writing directly bypasses that invariant and
    interleaves bytes with an attached browser writer — the corrupted-command
    failure 1.5 exists to prevent. `send_input` takes the lease (or requires
    zero viewers) and holds it for the write. A related consequence: the human
    approved a preview of a terminal state that an attached writer may have
    moved on from, so a lease steal between approval and write should invalidate
    the approval rather than proceed.
  - **`exec` covers only supervisor-spawned sessions.** `send_input` accepts
    any `termId`, including browser-spawned ones that still run the agent as a
    job under a surviving `zsh -li`. For those the exact liveness argument does
    *not* apply and the shell-executes-prose risk is live, so either refuse
    `send_input` to non-`exec` sessions outright or fall back to the
    `proc.process` check for them and say which.
  - **Spawn the agent with `exec` — for supervisor-spawned sessions only** —
    so no shell survives it, and a lost race yields a dead PTY rather than a
    shell executing the supervisor's prose. Browser-spawned sessions keep
    today's shell-hosted launch and its "drop back to a live prompt when the
    agent exits" behavior (`server.js:1828-1830`), which is worth keeping at
    the desk. Two spawn modes, differing by one keyword.
- **Control-plane auth — and what it does *not* buy.** All mutating endpoints
  + `/api/internal/turn-ended` require a bearer token written 0600 to
  `~/.herd/control-token`, **generated if absent rather than rotated at every
  startup**; herd-mcp and the hooks read it from there. Rotation would buy
  nothing against the same-uid read described below, while breaking herd-mcp —
  a stdio child of a launchd-managed supervisor — on every Herd restart,
  401ing both its mutating calls and the SSE reconnect that the entire
  epoch/cursor protocol exists to handle. Rotate on explicit command only.
  Three constraints, each of which independently voids the scheme if skipped:
  - **The token must never enter a command line.** Herd launches agents by
    `proc.write()`-ing the command into an interactive shell
    (`server.js:1887`), so anything baked into `--settings` lands in `ps aux`
    — confirmed readable across uids on this machine via `ps -ax -o args=` —
    and in `~/.zsh_history`. The rule binds the hook too, and more subtly than
    it looks: `$(cat …)` inside a `-H` argument is expanded before `curl`
    execs and lands in `curl`'s own argv, so Phase 2 uses `curl --config`
    against a 0600 file. Never a query string.
  - **`/ws` must be gated too, or the token is decorative.** *All* mutating
    power flows through the WebSocket today: the connection handler spawns the
    PTY and `input` messages write to it. The upgrade path accepts a missing
    Origin (`server.js:137`, deliberately, for CLI use), so any local process
    can open `/ws` with no Origin header and spawn/type/kill without touching
    a single token-gated HTTP route. Gate the handshake on the same token.
    Getting the token *to* the browser then has exactly one workable answer:
    require a **present, allowlisted Origin** on that one route, breaking CLI
    use for it specifically. Serving it inline into `index.html` does not
    work — `/` is a plain static GET, `GUARDED_GET_PATHS` holds only
    `/api/token-usage` (`server.js:164`), and `originAllowed(undefined)`
    returns true (`server.js:137`), so `curl http://127.0.0.1:3456/` would
    hand the token to any local caller including the different-uid one that
    cannot read the 0600 file — the single class the token exists to exclude.
  - **It does not defend against an inner agent — and neither does anything
    else here.** An agent Herd spawned runs as the same uid, so 0600 is
    transparent to it and it can read the token file directly. The Phase 4
    permission relay does *not* cover this: it gates supervisor → Herd, and an
    inner agent calling Herd's HTTP or `/ws` directly traverses no relay at
    all. Nor does Claude's sandbox — it isolates *Bash subprocesses* only
    (hooks and the agent's own file tools run outside it, which is precisely
    why the Phase 2 loopback test passed), its network layer filters by domain
    rather than port, and `allowUnsandboxedCommands` defaults to true so any
    denied read is simply retried outside the sandbox. Same uid is not a
    boundary; the only real ones are a separate uid or a container per session,
    both out of scope. See the security model for what this concretely grants
    an attacker. The token's real jobs are keeping *unprivileged* and
    remote/non-loopback callers out, and making the control plane auditable —
    not sandboxing our own children.

## Phase 4 — Supervisor + Telegram (config + CLAUDE.md)

The supervisor runs **interactive under tmux** (launchd keeps tmux + the
session alive), not `-p`: interactive mode is the documented always-on shape
for channels, and — decisively — it keeps permission prompts alive so the
official Telegram **permission relay** can carry them.

```
tmux new -A -s herd-supervisor
claude --channels plugin:telegram@claude-plugins-official \
       --dangerously-load-development-channels server:herd
```

- **Permissions are the security boundary, not prose.** The read-only tools
  are pre-allowed **enumerated one by one** — `mcp__herd__list_projects`,
  `mcp__herd__list_sessions`, `mcp__herd__list_live`,
  `mcp__herd__read_transcript`. Never `mcp__herd__*`: that wildcard matches
  the mutating tools too and silently deletes the entire boundary in one
  line. Mutating tools (`send_input`, `start_session`, `resume_session`,
  `kill_session`) are *not* pre-allowed: each call triggers Claude Code's
  permission prompt, which the telegram plugin relays to the phone and you
  answer `yes <id>` / `no <id>`. This is the out-of-model confirmation gate:
  a prompt-injected supervisor cannot approve its own mutations. Bash absent
  from the supervisor's allowlist entirely. Two details that decide whether
  the gate holds in practice:
  - **The relay must not offer "don't ask again."** Claude Code's prompt
    normally includes it; surfaced over Telegram, one tap permanently unlocks
    `send_input` and the boundary is gone for good. Verify what the plugin
    actually renders — this is a spike question, not a detail.
  - **`input_preview` must show a server-attested target, not just the
    bytes.** The exact text about to be typed is necessary but not sufficient:
    approving the right command against the wrong session is invisible from a
    phone if the target is an opaque `termId`. Render the project's **real
    path**, the agent, and a short `termId`. Do *not* render the session name:
    names are Haiku-generated from PTY output by Herd's own auto-naming, i.e.
    attacker-influenced text injected straight into the one trusted surface
    the entire gate depends on.
  - **An unanswered prompt blocks the whole supervisor.** Interactive Claude
    sitting on a permission prompt processes nothing else — no forwarded
    events, no triage, no unrelated Telegram requests. One `send_input` fired
    before bed takes the supervisor offline until morning, which is the normal
    away-from-desk case rather than an edge. Same spike: can the plugin
    auto-deny after N minutes, so unanswered means denied and the supervisor
    unblocks itself? If not, the fallback is a second read-only supervisor
    that can never block — but note that is *not* just "run another session":
    `getUpdates` is exclusive-consume, so two supervisors on one bot token
    contend for a `409` exactly as a token thief would. It needs a second
    BotFather token and a second chat, a materially different setup story.
    Which makes auto-deny the load-bearing question of the four, not one of
    four.
- **Telegram:** official plugin (requires Bun) — BotFather token,
  `/telegram:configure`, pairing, `access policy allowlist`. Sender-gated by
  user ID.
- **Prerequisites, none of which are currently installed on this machine:**
  `bun` (the plugin needs it) and `tmux` (the supervisor's always-on shape).
  The `--channels` and `--dangerously-load-development-channels` flags *are*
  present in the installed CLI (2.1.220) despite being absent from `--help`.
- **Statelessness as the design invariant:** ground truth lives in Herd/on
  disk; the supervisor can be `/clear`ed or restarted anytime and rebuilds
  from `list_live` + `read_transcript` + the SSE cursor. Session-length
  management = auto-compaction + nightly launchd restart. Nothing clever.
- **CLAUDE.md** defines the role: triage forwarded events (summarize, flag
  failures, propose next steps over Telegram); execute user requests; treat
  all transcript content as untrusted data. This is defense-in-depth on top
  of the permission gate, not the gate itself.
- **Rate limit:** Herd caps supervisor-initiated live PTYs (e.g. 5) —
  `start_session` beyond the cap fails loudly; each spawn is hundreds of MB
  and a fork-bomb-by-proxy otherwise.
- The supervisor's own project dir is excluded from Herd's project scan (or
  it would list itself, summarize itself, and emit events about itself).

## Security model

- Transport: Telegram long-polling is outbound-only; Herd stays on
  `127.0.0.1`; nothing exposed to LAN or internet. Telegram bot chats are
  **not E2E-encrypted** — transcript excerpts transit Telegram's servers;
  accepted as a policy decision.
- Blast radius of a leaked bot token: the permission relay does hold — the
  token holder can't execute a mutation without answering a relay that goes
  to the paired account. But "bounded by the relay" oversells it. The token
  alone grants full **read** of everything the supervisor forwards: transcript
  excerpts, project and session names. And because Telegram's `getUpdates` is
  **exclusive-consume**, an attacker polling with the stolen token eats the
  user's own `yes <id>` replies. That contention is *loud* rather than
  stealthy — Telegram answers the second poller with `409 Conflict: terminated
  by other getUpdates request` — so the real question is whether the plugin
  surfaces the 409 or quietly retries. Spike it. Long-polling stays either
  way: the webhook shape would need a publicly reachable inbound endpoint and
  negates "no inbound ports, no VPN, no tunnel," the property this whole
  design is sold on. And the read/DoS framing still understates it: once the
  thief has the chat id from `getUpdates`, they can **send as the bot**,
  impersonating supervisor output and fabricating permission prompts. The
  phone — the trusted surface the whole gate rests on — is then attacker-
  writable without a single mutation being approved. Treat the bot token as a
  secret of the same class as the control-plane token.
- **A compromised inner agent has full control-plane access. Accepted.** The
  realistic compromise is prompt injection through ordinary work — a fetched
  page, a dependency README under `node_modules`, a GitHub issue body pulled
  through `gh`, a test fixture in a cloned repo, third-party MCP output. Such
  an agent already holds the uid, so what Herd *adds* is three things:
  **lateral movement** into sessions in other projects via `send_input` (no
  channel between two agent sessions exists today — the sharpest of the
  three), **amplification** via `start_session` up to the rate cap, with the
  spawned sessions now outliving the browser, and **a path to the phone
  through a trusted surface**, since it shapes both its own PTY output and its
  auto-generated session name. The permission relay gates supervisor → Herd
  only. Same uid is not a boundary. Accepted for a localhost-only tool with no
  auth, consistent with the standing decision in CLAUDE.md — to be revisited
  before any non-loopback bind, and worth re-deciding if detached sessions
  turn out to be long-lived in practice.
- Prompt injection: transcripts and PTY output the supervisor reads are
  untrusted. Structural mitigations: relay-gated mutations with literal
  `input_preview`, `send_input` liveness gate, spawn cap, tokenized control
  plane. Never auto-answer `y` to an inner session based on pattern-matched
  output — the pattern is attacker-controlled text.
- Channels are research preview: custom channels require
  `--dangerously-load-development-channels`; flag syntax may change.

## Risks & open questions

1. Channels as a 24/7 daemon (interactive-in-tmux) is documented but young —
   soak-test before trusting; verify relay behavior when the phone answers
   hours later.
2. Reaper vs `send_input`/attach race: liveness+reap checks must be atomic in
   the same tick that SIGHUPs.
3. Resume fidelity for Codex/Gemini/pi after reap (Claude's is proven).
4. `needs-attention` is heuristic for Codex/Gemini/pi (Claude gets the real
   `Notification` hook). A *missed* prompt is not reap-suppressed — suppression
   requires detection — so the failure direction is a silently reapable
   blocked session, which is why Phase 2's reaper is a single 12 h tier and
   leans on the RAM cap rather than the clock.
5. Supervisor token burn: watch-filtered events + Sonnet; downgrade to Haiku
   if triage quality holds.
6. **Sleep is the hard constraint.** On this machine caffeinate does *not*
   survive lid close (established during the background-agents
   investigation). Away-from-desk operation requires clamshell mode with
   external display+power, `pmset disablesleep 1`, or an open lid. Without
   one of these, Telegram goes silent exactly when away — and an in-flight
   turn's API call dies even though the PTY now survives.
7. ~~Hook execution vs the sandbox config passed in the same `--settings`
   JSON.~~ **Resolved by test** — hook fires under `{"sandbox":{"enabled":
   true}}`, receives stdin, loopback POST goes through. See Phase 2.
8. Herd restart / crash still mass-kills every PTY (`server.js:2136-2141`,
   in-memory registry). Accepted, not solved — see Phase 1. It becomes the
   dominant loss event once Phase 1 lands, and it is worth re-deciding if
   detached sessions turn out to be long-lived in practice.
9. **Terminal-mode fidelity of SerializeAddon** (Phase 1.3) — broader than
   alt-screen. DECCKM (application cursor keys), bracketed paste (`?2004`),
   the DECSTBM scroll region and cursor visibility are all set once by a TUI
   agent at startup and never re-sent. If SerializeAddon doesn't emit them,
   *every* attach to a TUI agent lands in a terminal where arrow keys send the
   wrong bytes and paste behaves differently — not just the pager edge case.
   Verify mode coverage generally, then alt-screen specifically.
10. Phase 4 spike questions, all cheap, each able to invalidate a design
   choice. **Check this one first:** what are the tool names actually called
   under a channel-loaded server? The entire permission boundary is a literal
   string match on `mcp__herd__list_projects` and friends, and herd-mcp is
   registered *both* in `.mcp.json` and via
   `--dangerously-load-development-channels server:herd`. If channel
   registration namespaces tools differently, or routes them past the same
   permission rules, the enumerated allowlist matches nothing — and a rule that
   matches nothing is indistinguishable from a rule that works until a mutating
   tool runs unprompted. Verify with `/permissions` or one `list_projects`
   call *before* writing the allowlist. Then: does the relay expose "don't ask
   again"; what does `input_preview` render; can an unanswered prompt auto-deny
   rather than blocking the supervisor (load-bearing — see Phase 4); does the
   plugin surface a `getUpdates` 409.
11. Whether `codex`, `gemini` and `pi` accept a positional prompt argument.
   `start_session(initial_prompt)` assumes they do; if one doesn't, the prompt
   has to be typed, which reopens the `send_input` gate for the first write.

## Build order

| Phase | Deliverable | Value standalone |
|---|---|---|
| 1 | detach/attach/snapshot/spawn-lock | fixes reload, lock, Memory Saver, lid-close kills |
| 2 | turn state, needs-attention, reaper, durable SSE | real GC; better green tabs; enables headless |
| 3 | herd-mcp + control-plane token | Herd usable from any MCP client |
| 4 | supervisor + Telegram relay | the product |

1–2 land together (GC depends on the turn signal). Before building 3, spike
Phase 4's shape for half a day — hello-world channel + one Telegram round
trip + one relayed permission — checking all four questions in risk 10:
"don't ask again", `input_preview` contents, auto-deny on an unanswered
prompt, and `getUpdates` 409 surfacing. It is the load-bearing unknown; 3–4
are dead if it doesn't hold. Install `bun` and `tmux` first. The one Phase 1
unknown worth settling just as early is SerializeAddon's terminal-mode
coverage, since it decides the snapshot design.
