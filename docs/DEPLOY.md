# Deploying Herd on Railway

One container per user, Claude Code only. Everything deployment-specific is
switched on by env vars the Dockerfile sets, so a local `npm start` behaves
exactly as before.

## Layout

One Railway service per user, each with its own volume at `/data` and a Railway
domain (`railway domain --service <name>` prints it). Service names, URLs and
passwords live in Railway, not in this repo — the password is the only thing
between the internet and a shell.

Deploys are `railway up --service <name> --detach` from this directory — no
GitHub connection, so nothing auto-deploys. Run the CLI outside the Claude Code
sandbox: it writes `~/.railway`. `railway volume add` panics on CLI 4.30.5;
volumes were created through the GraphQL `volumeCreate` mutation.

## Service variables

| Variable | |
|---|---|
| `HERD_PASSWORD` | Required, long and random (`openssl rand -base64 24`): there is no lockout, only a 1s delay per failure. Without it the server refuses to bind `0.0.0.0`. Changing it logs every browser out. |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token` (subscription, not API). Unset → run `/login` in a Claude tab; the credentials land on the volume. |
| `TZ` | Optional IANA zone (e.g. `America/New_York`); the status line's reset time uses it. Default UTC. |
| `ALLOWED_ORIGINS` | Only for a custom domain. The Railway domain is allowed automatically via `RAILWAY_PUBLIC_DOMAIN`. |

Set by the Dockerfile: `HOST=0.0.0.0`, `HOME=/data/home`, `HERD_DATA_DIR=/data/herd`
(summary cache), `HERD_WORKSPACE=/data/work` (projects), `HERD_CLAUDE_SANDBOX=0`,
`SHELL=/bin/bash`, `DISABLE_AUTOUPDATER=1`.

Claude settings: at boot `deploy/claude/settings.json` is merged into
`~/.claude/settings.json` on the volume — `model`/`effortLevel`/`tui` only as defaults
(a `/model` choice sticks), `statusLine` always. The status line is a copy of
`~/.claude/statusline-command.sh` with a GNU `date` fallback; re-copy it after
changing the local one. A `setup-token` token can't read the plan, so without the
`model` default Claude would start on Sonnet.

## How it differs from local

- **Login.** `/login` sets a 30-day HttpOnly cookie, checked on every route and on
  the WebSocket upgrade. `/healthz` is the only open route (Railway healthcheck).
- **Projects.** The `+` in the sidebar header asks for a folder name under
  `/data/work` (created if missing) instead of the macOS picker. Clone repos from a
  terminal; `gh auth login` once and it persists in `HOME`.
- **Files.** The ⇅ button in the tab bar (active tab's project) or on a project's
  hover opens a Files panel: browse, **Upload files** / **Upload folder** through
  the system dialog, tick entries and **Download** — one file as itself, several or
  a folder as one `.tar.gz`. Pasting an image (or files copied in Finder) into a
  terminal uploads it to `<project>/uploads/` and types the path, since Claude in
  the container can't read your clipboard. Uploads never overwrite (`name (1).ext`),
  cap 500 MB each.
- **No Claude sandbox flag.** It would need bubblewrap and user namespaces; the
  container is the boundary.
- **Redeploys end running sessions.** PTYs are server children. Tabs come back
  through `--resume`. A volume attaches to one instance, so each deploy has a short
  outage.
- **Upgrading Claude Code** = bump the pinned version in the `Dockerfile` and
  redeploy.
- Codex, Gemini, pi and Grok aren't installed, so their buttons don't appear.

## Adding another user

```bash
railway add --service herd-<name>
# volume: GraphQL volumeCreate {projectId, environmentId, serviceId, mountPath: "/data"}
railway variable set HERD_PASSWORD --stdin --service herd-<name> --skip-deploys
railway domain --service herd-<name>
railway up --service herd-<name> --detach
```
