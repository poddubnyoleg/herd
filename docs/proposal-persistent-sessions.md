# Proposal: Sessions that outlive their viewer

> **Status:** Implemented 2026-10-03 (`server.js` "Terminals" section, `public/app.js`, `test/persistent.test.mjs`). Deviations from this draft:
> per-*tab* `client` id instead of per-page (two tabs on one terminal must not silently replace each other); an `HERD_DETACHED_IDLE_MINUTES`
> knob for the reaper's 30-minute idle window; both pinned xterm packages are loaded with the global `navigator` hidden (Node 21+ defines one,
> and xterm 5.3.0 then takes its browser path and throws); a mid-sequence cut gives up after 1 s if the agent stalls inside the sequence.
> Spike results: serialize ≈ 80 ms and 1.4 MB raw / 52 KB deflated at 10k lines × 140 cols, so the 10k scrollback stays; idle screens of
> claude, codex, gemini and grok restore row-for-row identical after a reload.
> **Date:** 2026-10-03
> **Supersedes:** Phase 1 of `proposal-telegram-supervisor.md`, with narrowed scope (see "Decisions")

## Summary

Today a Herd session dies whenever its browser tab loses the WebSocket:
`ws.on('close')` SIGHUPs the PTY (`server.js:2756`). The tab survives closing the lid, reloading the page,
a browser crash, a Wi-Fi blip and an iOS screen lock, but the agent does not. The proposal is to make the WebSocket
a *viewer* of a server-owned terminal. When the viewer disconnects, the PTY keeps running. When the viewer
returns, the server sends a snapshot of the screen plus scrollback, then streams live output.

The same code serves local and cloud deployments, with different payoffs:

- **Local:** closing the lid, reloading the page or a crash no longer kills sessions. That cascade was the root cause
  of the green-tabs saga, where morning greens were tombstones of sessions the lid close had killed. Sleep still
  freezes the agent, and an in-flight API call usually fails. The session survives; the interrupted turn may not.
- **Cloud:** nothing sleeps, so a turn keeps running while the laptop is closed. This change is what makes
  a cloud deployment worth doing. Authentication is a separate prerequisite for any cloud deployment (see "Cloud").

**Not solved, in either place:** a Herd server restart still kills every session, because PTYs are children of the
server process and the registry lives in memory. Recovery is unchanged: `--resume` from the transcript. Front-end
edits (`app.js`, `style.css`) need only a page reload, which becomes harmless, so restarts become rarer. Surviving
restarts requires a separate PTY-holder process and is out of scope (see "Future").

Estimated size is **~650 lines** across server, client and tests, or **4–5 days** including a half-day spike.

## Decisions (taken, flagged for review)

1. **Snapshot via `xterm-headless` + `xterm-addon-serialize`, not tmux.** The user prefers xterm.js scrollback
   (wheel, scrollbar, Cmd+C reflow) and inline images, and tmux degrades both. The packages are pinned to the
   client's line: `xterm-headless@5.3.0` and `xterm-addon-serialize@0.11.0`. The client vendors xterm 5.3.0, so the
   server's parser and reflow match the browser's exactly. Verified in the published 0.11.0 build, not just its
   source: `serialize()` takes `{scrollback, excludeModes, excludeAltBuffer}` and emits the alt buffer and modes.
   One reviewer claimed 0.11.0 serializes only the normal buffer; that is wrong for the published package.
2. **One viewer per terminal, and only an explicit user action takes it.** Opening a tab, clicking a sidebar
   entry, or clicking "take over" may displace another viewer. That viewer gets `detached{reason:'opened-elsewhere'}`
   and does not auto-reconnect. **Automatic reconnects never displace a live viewer** (see "Connection routing").
   Without that rule, a phone that unlocks, or a laptop window that wakes, would grab the session from whichever
   device is in active use. This removes writer arbitration, per-viewer geometry and viewer fan-out from the
   supervisor proposal's Phase 1 (its item 5).
3. **✕ still kills.** Only *unintended* disconnects detach: reload, lid close, network loss, browser crash, closing
   the window. The supervisor proposal made ✕ detach for its phone/Telegram case. That case is out of scope here,
   and keeping ✕ as kill preserves today's UX.
4. **Images are not restored on reattach.** The serialized snapshot is text-only, and the headless terminal has no
   image addon. Live images render as today. A side effect: the browser's image addon advances the cursor past the
   rows an image occupies, while the headless terminal does not. After reattach those rows are therefore absent,
   and the restored text sits where the agent's own TUI believes it is. This is a visual difference, not stream
   corruption: `imgcat` writes past the agent's renderer, so the headless layout is the one consistent with the
   agent's later cursor movements. Today's reconnect (`--resume` replay) does not restore images either, so this is
   no regression.

## Design

### Server: per-terminal state instead of per-connection closures

The connection handler (`server.js:2320-2765`) owns everything through closures: the PTY, auto-naming buffers and
timers, session-id detection, backpressure and `sessionEnded`. Split it:

- `spawnTerminal(params) → term` contains today's handler body from validation through spawn, auto-naming and
  detection. Every `ws.send` becomes `term.send(obj)`, a no-op while no viewer is attached.
- The registry `terminals: termId → term` gets these fields:
  `{ proc, headless, serializer, viewer: ws|null, viewerClientId, sessionId, agent, project, title, chunkTimes,
  lineHighWater, detachedAt, lineHighWaterAtDetach, ... }`.
  `term.title` caches the latest live title so it can be included in the attach reply.
- `attachViewer(term, ws, clientId, cols, rows)` and `detachViewer(term, ws)`.
- **Every viewer-originated event checks identity**: `close`, `input`, `resize` and the kill close code are ignored
  unless `term.viewer === ws`. After a takeover, the replaced socket can still deliver queued frames until its TCP
  close is processed. Today that race dies with the PTY. Here, an unchecked `input` or kill from the replaced window
  would hit the session the new window just attached to.
- **The output coalescer belongs to the viewer.** Today's 8 ms `wsSendBuf` (`server.js:2696-2718`) holds bytes that
  have already been fed to the headless terminal. Attach and detach discard it. Otherwise its timer fires after the
  attach marker and replays bytes the snapshot already contains.
- `proc.onExit` stays the only place that ends a terminal: stop timers, `term.send({type:'exit'})`,
  delete it from the registry.
- `ws.on('close')` from the current viewer calls `detachViewer`. It does **not** clear naming or detection timers
  and does **not** kill.

### Connection routing

`/ws?attach=<termId>&resume=<sessionId>&client=<pageId>&steal=0|1&project&agent&cols&rows`

- `client` is a random id the page creates at load and keeps in memory. A reconnect from the same page may always
  replace its own previous socket, even one the heartbeat has not reaped yet (a ghost). After a lid open, the
  page's own reconnect therefore does not wait up to 60 s for the heartbeat.
- `steal=1` is sent only for explicit user actions. Automatic reconnects send `steal=0`.

Resolution order, after the same validation as today (agent, UUID format for `attach` and `resume`, project path):

1. `attach` names a live terminal, or `resume` matches a live terminal by `(agent, sessionId)`:
   - attach if the terminal has no viewer, if the viewer has the same `client`, or if `steal=1`;
   - otherwise reply `busy`. The client shows "Open in another window. Click to take over." and keeps retrying
     quietly with backoff, so it attaches by itself once the other viewer leaves.

   Matching by `resume` replaces the kill-and-respawn takeover at `server.js:2369-2390`. Clicking a running session
   in the sidebar, or opening Herd on a second device, therefore attaches to the session instead of killing it.
2. `attach` was given, nothing is live, and there is no `resume`: send
   `error{code:'session-gone', message:'Session ended'}`. This is a new session whose id was never detected and
   whose PTY died, typically after a server restart. Nothing can be resumed, so the client marks the tab dead
   instead of silently spawning a fresh session.
3. Otherwise, spawn exactly as today (`--resume` if `sessionId` is set, new session otherwise).

### Snapshot on attach

Each terminal owns a headless `Terminal({cols, rows, scrollback: 10000, allowProposedApi: true})`. The scrollback
matches the client's (`app.js:908`). Every PTY chunk is written to the headless terminal in addition to the viewer.

The attach sequence is ordered on the single viewer socket, so the client needs no sequence watermark:

1. Discard the old viewer's coalescer and reset backpressure state (see "Backpressure"). Set `term.viewer = ws`,
   but send nothing live: PTY output for this viewer goes into a pending list.
2. **Cut at a parser boundary.** Call `headless.write('', cb)`. The callback fires once the parser has consumed
   every chunk queued before it. A chunk boundary is not a sequence boundary, though: node-pty splits output
   arbitrarily, so the parser may be in the middle of a CSI sequence, or of a several-hundred-KB OSC 1337 image
   payload. Cutting there would have the client print the tail as text (`;240m`, or a screenful of base64).
   So, in `cb`, read the parser state. If it is not `GROUND`, move the cut forward: chunks that arrived since the
   last marker count as already in the snapshot, the pending list is cleared, and a new marker goes in behind
   them. Repeat until the state is `GROUND`. Sequences terminate, so this ends within a few chunks, or after one
   image payload.
   - The state is private API (`headless._core._inputHandler._parser.currentState`). That is acceptable here
     because xterm is pinned, and Herd already uses a private API for the same reason (`syncViewport`,
     `app.js:1446`). The spike confirms the path exists in 5.3.0.
3. Resize the headless terminal to the viewer's `cols × rows`. This happens after the drain, so output queued at
   the old size is parsed at the old size.
4. Send `attached{termId, sessionId, title, working, grewWhileDetached}`, then
   `snapshot{data: serializer.serialize()}`, then the pending list, and switch to live streaming.
5. Resize the PTY to `min(cols, MAX_COLS) × rows`, the same cap the spawn path applies (see "Width cap"). The
   agent's SIGWINCH redraw arrives through the live stream.

`serialize()` in 0.11.0 (`SerializeAddon.ts:456-505`):

- emits the normal buffer;
- if the alt screen is active, emits `CSI ?1049h` plus the alt buffer;
- emits modes: DECCKM, keypad, bracketed paste, insert, origin, reverse-wrap, focus reporting (1004), wraparound,
  and mouse tracking (9/1000/1002/1003).

Gaps found in the source, to close with `headless.parser.registerCsiHandler` observers (return `false` so
xterm still handles the sequence) and to append to the snapshot:

- Mouse **encoding** (SGR `?1006`). Without it, the client sends X10-encoded reports to an app expecting SGR.
- Cursor visibility (`?25l`). Cosmetic: a stray blinking cursor in TUIs that hide it.
- Scroll region (DECSTBM) and cursor style (DECSCUSR). These are worth checking in the spike; they may not
  matter for the agents Herd runs.

**Compression.** Enable `ws` `perMessageDeflate` with a 64 KB threshold, so only snapshots are compressed and
live output keeps today's latency. Snapshots are text with repetitive escape codes, which matters on a phone
connected to a cloud host.

### Terminal query replies

TUIs ask the terminal questions (DA, DSR cursor position) and some wait for the reply.

- **With a viewer attached**, the browser's xterm answers, as today.
- **With no viewer**, the headless instance answers: `headless.onData → proc.write`.
- The decision is made **per chunk, at arrival**, not when the chunk is parsed. Each chunk is tagged with whether a
  viewer was attached when it arrived, and headless replies are forwarded only while parsing untagged chunks.
  Otherwise, under parse lag, a query the browser already answered could get a second reply after a detach. That
  reply would land in the agent's stdin as typed text.
- During the attach handoff (step 1 until the client has written the snapshot), a query can go unanswered by
  either side. That is deliberate. An unanswered query times out in the agent. A duplicate reply is injected into
  its input, which is worse.
- The headless build does **not** answer OSC 10/11 color queries: only the browser build handles them
  (`_handleColorEvent` in `src/browser/Terminal.ts`; nothing equivalent in `src/headless/Terminal.ts`). A TUI that
  queries colors while detached gets no answer and falls back to its default. Agents query colors at startup,
  and sessions always start attached.

### Backpressure

- **Viewer attached:** today's policy, pause the PTY above 1 MB queued on the socket (`server.js:2698-2733`).
- **Headless parse lag, always:** `headless.write` is asynchronous, so a runaway `yes` or build log with no viewer
  is now parsed on the event loop shared with every other terminal and the UI. Count bytes between `write` and its
  callback; pause the PTY above 4 MB pending and resume under 512 KB. This also stays far below xterm's 50 MB
  discard limit.
- **Attach and detach both re-evaluate the pause.** Today the PTY resumes only inside `flushWsBuf`, which runs
  only when new output arrives. Take a PTY paused on a dead socket that a reconnect replaces before the heartbeat
  reaps it: the dead socket's `close` is ignored by the identity check, no output arrives, and the PTY would stay
  paused forever. On every viewer change, resume the PTY unless the headless lag still requires the pause.

### Width cap (`MAX_COLS = 96`)

The cap is applied once at spawn via `stty cols` (`server.js:2456-2463`). The live resize path forwards the client's
cols uncapped (`server.js:2750-2751`). Attach applies the same cap as spawn (step 5), so a reconnect behaves like
a fresh spawn and does not widen the PTY. The live resize path stays unchanged: capping it would reflow every
running agent, and is a separate decision about a pre-existing inconsistency. The headless terminal always takes
the client's real cols, because that is what the browser renders the stream into.

### Reaper (destructive by design)

A detached terminal nobody returns to (lost `localStorage`, a different browser, a forgotten tab) would otherwise
live until the server restarts. On a cloud host it costs about 0.3–0.5 GB of RAM per agent.

Every 10 minutes, SIGHUP a detached terminal that meets either condition:

- detached for at least `HERD_DETACHED_TTL_HOURS` (default 24) **and** no content growth for 30 minutes; or
- detached for at least `HERD_DETACHED_MAX_HOURS` (default 72), regardless of activity.

**Growth**, not raw output, is the idle signal: the headless terminal's `baseY + cursorY` passes its high-water mark,
the same rule the client uses in `trackTabActivity` (`app.js:1303`). Raw output would never go quiet for TUIs
that repaint while idle, such as gemini's ~2 s footer or a refreshing status line, and their sessions would never
be reaped.

This policy is knowingly destructive. A tool that runs silently for hours inside a detached session is killed at
the hard cap. The conversation resumes via `--resume`, but running child processes do not survive. No reliable
"turn complete" signal exists without hooks (supervisor proposal Phase 2). The sidebar's running marks and kill
action are the manual alternative.

### Turn state on attach

`attached` is a new message, distinct from `ready`. `ready` is already re-sent when session-id detection lands
(`server.js:2555`), up to 5 minutes after spawn, so gating on `ready` would re-arm the input gate after the user had
typed. The attach reply carries two flags:

- `working`: at least 4 output chunks in the last 2 s, the client's own rule (`armFinishedTimer`, `app.js:1356`).
- `grewWhileDetached`: content grew since the last viewer left (`lineHighWater > lineHighWaterAtDetach`).

Client handling:

- **`working`:** clear `_awaitingInput`. Normal tracking takes over, and the tab goes green when the turn finishes.
- **`grewWhileDetached && !working`:** the turn finished while nobody was watching. A background tab is marked
  finished (green) immediately, and the gate clears. This is the main cloud payoff: "which sessions finished while
  I was away" is visible at a glance.
- **Neither:** the session sat idle. `_awaitingInput` stays set, exactly as after today's reconnect.

These are heuristics. Hook-reported turn state is the real version (supervisor proposal Phase 2).

## Client (`public/app.js`)

- **Persist `termId`.** Today the client ignores the `termId` in `ready` (`app.js:1211-1216`). Store it.
  `saveTabState` (`app.js:303`) keeps tabs that have a `termId` **or** a `sessionId`. Today's `sessionId`-only
  filter drops a new session from reload during the up-to-5-minute detection window, which this proposal closes.
- **`createTab` and `restoreTabState` take `termId`.** Restoring the active tab and deduplicating open tabs match on
  `termId` as well as `sessionId` (`app.js:880-883`). Otherwise clicking a "running (unnamed)" sidebar row for a
  session already open in a tab would attach a second viewer and show "opened elsewhere" on the tab that owns it.
- **`connectWebSocket`** (`app.js:1121`) sends `attach`, `resume`, `client` and `steal`. `steal=1` only from
  `createTab` triggered by a user click, or from a "take over" click.
- **Suppression moves out of `onopen`.** `onopen` does not yet know whether the connection will attach or spawn.
  Today's 15 s post-connect window and the `_awaitingInput = true` reset (`app.js:1135-1150`) move to the first
  `ready` of a connection, which only a spawn sends before any output. `attached` instead follows "Turn state on
  attach".
- **`snapshot` message:**
  1. Cancel `_writeRaf` and clear `_writeBuf`. The rAF batch freezes in hidden pages and could otherwise flush
     pre-disconnect output on top of the restored screen.
  2. `terminal.reset()`, then write the snapshot.
  3. After the write, `scrollToBottom`, `syncViewport`, and reset `_lineWatermark`.

  The snapshot write bypasses `trackTabActivity`.
- **`detached{opened-elsewhere}`** replaces `takenover` (`app.js:1230`): `alive=false`, no reconnect, and an overlay
  "Opened in another window. Click to take over." Clicking it reconnects with `steal=1`.
- **`busy`:** same overlay, with quiet retries (`steal=0`) on the existing backoff.
- **`error{session-gone}`:** mark the tab dead and drop it from saved state. The message text is included, so the
  generic error path (`app.js:1252-1254`) prints it.
- **Reconnect** (`app.js:1259-1272`) fires for tabs with a `termId` *or* a `sessionId`. Today it requires a `sessionId`.
- **Restore is staggered.** `restoreTabState` attaches the active tab first and the background tabs about 150 ms
  apart. `serialize()` is synchronous, so a reload or wake that attaches 10–15 tabs at once would block the event
  loop shared by every terminal.
- **✕** (`closeTab`, `app.js:1450`):
  - If this page holds the viewer slot and the socket is open, close it with code **4001**, which the server
    treats as kill. A close code arrives atomically with the close itself, so no separate message can be lost
    or reordered.
  - If the socket dropped while this page held the slot (reconnect backoff), send `DELETE /api/live/:termId`.
  - After `opened-elsewhere` or `busy`, close the tab locally only. Killing there would take down the session
    another window is using.
- **Remove the `beforeunload` warning** (`app.js:194`): closing the page no longer kills anything.
- **Sidebar:** fetch `GET /api/live` on load and every 10 s, returning
  `[{termId, pid, agent, sessionId, project, title, attached, lastGrowthAt}]`. Sessions running server-side get a
  "running" mark. Live terminals without a `sessionId` (detection pending) appear as "running (unnamed)" under their
  project and attach by `termId`. Each live entry has a kill action.

## Server API additions

- `GET /api/live`: the list above. It is added to `GUARDED_GET_PATHS`, so a cross-origin browser request is refused
  on its `Origin` header. As with every route today, a request with no `Origin` (curl, local processes) is allowed.
- `DELETE /api/live/:termId`: kills the terminal. It is Origin-guarded like every non-GET route.
- WebSocket close code 4001 from the current viewer kills the terminal.

## Cloud

This feature needs no cloud-specific code, but it **widens what an unauthenticated client can reach**. Today, a
client that can reach `/ws` can spawn a shell. After this change it can also list running sessions and attach to
an already-authenticated agent mid-turn. A missing `Origin` is allowed by design (`server.js:164`), and CLAUDE.md
already names authentication as the thing to revisit before any non-loopback bind. **A cloud deployment must put
authentication in front of every HTTP route and the WebSocket upgrade.** That work is tracked separately from
this proposal.

Railway WebSockets have no duration or idle limit, so the 30 s heartbeat and the reaper are the only lifetime
policy. On a paid host, set `HERD_DETACHED_TTL_HOURS` and `HERD_DETACHED_MAX_HOURS` lower to bound RAM. Each headless
buffer costs up to about 17 MB at 10k lines × 140 cols, which is negligible next to an agent process.

## Spike (half a day, first)

1. Node script: spawn `claude` in node-pty, feed `xterm-headless@5.3.0`, and serialize at three points: mid-turn,
   during a permission dialog, and in a `less` pager. Write each snapshot into a fresh browser xterm 5.3.0 and
   compare visually. Repeat for `codex` (alt-screen), `grok --minimal`, `gemini` and `pi`.
2. Confirm the parser-state path (`_core._inputHandler._parser.currentState`) exists in the 5.3.0 headless build.
   Then feed a CSI sequence and an OSC 1337 payload split across chunks, attach between the chunks, and check that
   the cut moves forward and the client prints no fragments.
3. Confirm the gap list (1006, 25, DECSTBM, DECSCUSR) against the agents above. Close only the gaps that bite.
4. Measure snapshot size (raw and deflated) and serialize time for a long Claude session at 10k lines. Run it
   for one attach and for 15 concurrent attaches. If a staggered restore still blocks for more than ~200 ms per
   attach, cap the snapshot's scrollback below 10k.

## Tests

The suite is stale (~40 pre-existing failures from UI drift), so compare messages rather than bisecting. Today's
`closeTab` coverage checks only the DOM tab count, so nothing currently asserts that ✕ kills the PTY. New Playwright
cases:

1. **Reload keeps the process.** Open a session and read its PID from `/api/live`. Reload the page: same PID, and the
   tab shows the pre-reload screen.
2. **Socket drop keeps the process.** Close the socket from the server side: the client reconnects, same PID.
3. **✕ kills.** The PID is gone and `/api/live` is empty.
4. **Second window, explicit.** Open the same session from a second page's sidebar: the first page shows "opened
   elsewhere" and does not reconnect.
5. **Second window, automatic.** Drop the first page's socket while the second page is attached: the first page
   gets `busy` and does not take the session back.
6. **Replaced socket is inert.** After a takeover, input and close code 4001 from the replaced socket have no
   effect, and the PID is unchanged.
7. **Split sequence.** Attach while the PTY is mid-escape-sequence (a test agent that writes a split SGR sequence
   and a split OSC 1337 payload on cue): no fragments appear in the client buffer.
8. **Alt-screen fidelity.** Run `less` on a long file, reload, then press arrow keys: the pager scrolls. This
   checks the alt buffer and DECCKM restoration.
9. **Finished while away.** Detach, let a test agent print lines and go quiet, reattach the tab in the background:
   it is green. With no growth, it is not.
10. **Reaper.** With the TTL set to seconds, a detached terminal with no growth disappears; one printing new lines
    survives until the hard cap.

## Sizing

| Part | Lines |
|---|---|
| Server: state split, routing and steal policy, attach with parser-boundary cut, query replies, backpressure, reaper, API | ~350 |
| Client: termId persistence, snapshot, attached/busy/detached/gone, kill, staggered restore, sidebar running state | ~180 |
| Tests | ~120 |

The supervisor proposal sized its Phase 1 at 500–700 lines. This lands in the same range: decisions 2 and 3 remove
multi-viewer work, and the review findings add it back elsewhere.

## Risks

1. **The input gate and green pulse were hard-won** (green-tabs saga). Attach changes their entry condition
   (`working` / `grewWhileDetached` instead of always awaiting input).
   - Expected new greens after a local lid open: a turn in flight at sleep usually fails or retries on wake. That
     prints output, which counts as growth while detached, so the tab goes green. That reads as "needs a look",
     which is arguably correct, but it is a visible change.
   - Mitigation: `__herd.dumpLog()` logs every attach with both flags, and the saga's lid-close scenario is re-run
     manually.
2. **Snapshot fidelity on exotic modes.** The spike either closes this risk or narrows it to the named gaps.
3. **Private parser-state API.** Pinned xterm makes it stable. A future xterm upgrade must re-check it, alongside
   the existing `syncViewport` dependency.
4. **The reaper can kill silent long-running work** at the hard cap. This is accepted and documented; the knobs
   are configurable.
5. **Behavior change: closing the window no longer stops agents.** This is intentional, but it is a new way to
   leave work running unnoticed. Mitigation: the sidebar "running" marks.

## Future (out of scope)

- **Survive server restarts.** Move PTY ownership into a small long-lived holder process (or `dtach`), with Herd
  as a client that reattaches on start. The headless snapshot design carries over unchanged.
- **Delta reattach after short blips.** Keep a byte ring with sequence numbers and send only the missing bytes
  instead of a full reset. This requires the client to stop writing its local `[disconnected]` markers into the
  terminal.
- **Multi-viewer**, and the supervisor proposal's Phases 2–4.
