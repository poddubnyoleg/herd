# Critical Assessment of DEEP_IMPROVEMENTS.md

## Corrections (things the plan gets wrong)

1. **C2's proposed fix would break all agents.** The plan proposes a whitelist of "safe" env vars (`PATH`, `HOME`, `TERM`, etc.) and strips everything else. But the agents *need* their API keys: Codex requires `OPENAI_API_KEY`, Claude falls back to `ANTHROPIC_API_KEY` when OAuth is unavailable, and Gemini loads `GEMINI_API_KEY` from `~/.gemini/.env` (which is already handled separately via `geminiEnv`). Since Herd spawns an interactive shell (`/bin/zsh -li`), users also expect their full shell environment — PATH aliases, nvm, direnv, etc. The real threat model here is C1 (cross-origin WebSocket). If C1 is fixed, the env leak only matters for local attackers who already have localhost access. C2 should be reclassified as a defense-in-depth measure behind C1, and the fix should be an explicit agent-specific env pass-through, not a whitelist that will silently break functionality.

2. **C3's "remove stty entirely" fix would also remove the `clear` command.** The current line is `stty cols ${targetCols} rows ${rows} 2>/dev/null; clear; `. The `clear` is intentional — it clears the shell startup output before the agent launches. If you remove the whole `setSize` string, the agent's first frame overlaps with shell init garbage. The fix should be `const setSize = 'clear; ';` (preserve clear, drop stty).

3. **H1 says "81 synchronous fs calls" but there are 67.** I recounted: 67 total, 65 inside request handlers. The number 81 in the document is wrong.

4. **H1 references "C4 below" but no C4 exists.** This is a dangling cross-reference; it should point to M3 (the `decodeProjectPath` backtracking item).

5. **The document claims "the original IMPROVEMENTS.md items (B1–B9, F1–F10, P1–P10, R1–R5, S1–S3) have all been shipped."** This is false. Five items were never implemented: F3 (tab close confirmation — `_closeRequested` is defined but never used in `requestCloseTab`, which just calls `closeTab` unconditionally), F6 (tab context menu), F7 (browser notifications), P4 (tab scroll arrows), P8 (CDN fallback). This makes L6 a duplicate of the unshipped F3.

## Uncertainties / things that need discussion

6. **H6 (SSE heartbeat) is overstated for a localhost app.** The rationale says "reverse proxies, load balancers, and browser implementations commonly close SSE connections that have been idle for 30–60 seconds." But Herd binds to `127.0.0.1` by default — there are no reverse proxies or load balancers in the path. Browser SSE timeouts on direct localhost connections are typically hours. Summary updates are also idempotent (the next `GET /api/projects` fetches current data). The heartbeat is still a good practice, but its impact and priority should be lowered.

7. **M3 (O(3^n) path decoder) is a theoretical concern, not a practical one.** I tested `decodeProjectPath` against all 17 actual project directories — total time: **2ms**. The backtracking prunes aggressively because paths actually exist on disk. The worst case only manifests with adversarial directory names that don't exist, which isn't a real scenario. A cache is fine to add but this shouldn't be Medium priority.

8. **M6 (orphaned PTY processes) is handled by Unix terminal semantics.** When the Node process dies, the PTY master fd is closed, which sends SIGHUP to the slave shell, which propagates SIGHUP to its children (claude/codex/gemini). This is standard Unix terminal cleanup. Only processes that ignore SIGHUP or daemonize would survive, which isn't typical for CLI agent tools. The PID-file approach in the fix is overengineered for this.

9. **M8 (Gemini env at startup) is trivial — the file is 55 bytes.** The synchronous read takes microseconds. Lazy-loading is a fine pattern but this shouldn't be a Medium-priority item.

10. **H4's fs.watch proposal would be noisy for JSONL files.** Claude/Codex/Gemini write JSONL files by appending lines during active sessions. `fs.watch` would fire on every append, triggering rescans for files that are mid-write. The current approach (rescan on `GET /api/projects`) is actually reasonable — the real issue is that the frontend only fetches on user action. A simpler fix would be a periodic frontend poll (every 60s) or a server-side periodic rescan that pushes changes via the existing SSE channel.

11. **C1's Origin check should explicitly allow missing Origin headers.** Non-browser clients (curl, node scripts) don't send Origin. The proposed code uses `if (origin && ...)` which correctly skips the check when Origin is absent. This is the right behavior since non-browser local clients already have localhost access. But the plan should explicitly call out this design decision so a future maintainer doesn't "tighten" it by rejecting missing Origin headers.
