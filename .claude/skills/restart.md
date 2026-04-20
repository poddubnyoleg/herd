---
description: Restart Herd locally — kill the current instance and launch a new one
user_invocable: true
---

# Restart Herd

Use the repo's restart script:

```bash
bash ./scripts/restart-herd.sh
```

Then verify the restart:

```bash
lsof -iTCP:3456 -sTCP:LISTEN
tail -n 20 /tmp/herd.log
```

Rules:

- Prefer the repo script over ad hoc restart snippets.
- Run the restart as a single foreground Bash call. NEVER use `run_in_background` — it kills child processes on cleanup.
- Report whether port `3456` is listening and point the user to `/tmp/herd.log` for server output.
