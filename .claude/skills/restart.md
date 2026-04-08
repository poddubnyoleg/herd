---
description: Restart Herd locally — kill the current instance and launch a new one
user_invocable: true
---

# Restart Herd

Kill any running Herd server and start a fresh instance using a single command:

```
lsof -ti:3456 | xargs kill -9 2>/dev/null; node /Users/pd/Documents/herd/server.js &
```

Run this via Bash with `run_in_background: true`, then after 2 seconds verify with `lsof -i:3456 -sTCP:LISTEN` and report the result.
