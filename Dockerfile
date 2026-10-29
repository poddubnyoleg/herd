# Herd for Railway: one container per user, Claude Code only. The volume at
# /data holds everything that must survive a redeploy: HOME (Claude transcripts,
# ~/.claude.json, gh/git config), project checkouts and the summary cache.
# Local Herd never reads this file. Walkthrough: docs/DEPLOY.md.

FROM node:22-bookworm-slim

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    SHELL=/bin/bash \
    HOST=0.0.0.0 \
    HERD_DATA_DIR=/data/herd \
    HERD_WORKSPACE=/data/work \
    HERD_CLAUDE_SANDBOX=0 \
    DISABLE_AUTOUPDATER=1

# python3/make/g++: node-pty has no Linux prebuild and compiles at install;
# they also stay useful to the agent. jq + tzdata serve the status line
# (deploy/claude; set TZ as a service variable). gh comes from GitHub's own apt repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git openssh-client ca-certificates curl tini gosu procps less jq tzdata \
        python3 make g++ \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    # Pinned: auto-update can't write to the global npm dir as the herd user,
    # and a pin is what busts the cached layer. Bump it to upgrade.
    && npm install -g @anthropic-ai/claude-code@2.1.291 \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

# Claude Code refuses some modes under root, and the agent shouldn't own the
# image anyway. The home dir lives on the volume, created at boot.
RUN useradd --uid 10001 --home-dir /data/home --no-create-home --shell /bin/bash herd

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-node-pty.js scripts/
RUN npm ci --omit=dev && npm cache clean --force

# yt-dlp for the yt-subs skill (deploy/claude/skills): the standalone build
# bundles curl_cffi (without impersonation YouTube 429s the subtitle endpoints)
# and the EJS challenge solver, which runs on the image's node — /etc/yt-dlp.conf
# enables it, since yt-dlp only looks for deno by default. Pinned like Claude
# Code; its directory is herd's so `yt-dlp -U` (which follows the symlink and
# writes a sibling file) works between deploys when YouTube breaks it. A symlink,
# not ENV PATH: a login shell's /etc/profile resets PATH for non-root users.
ARG YT_DLP_VERSION=2026.10.26
RUN case "$(dpkg --print-architecture)" in \
        amd64) asset=yt-dlp_linux ;; arm64) asset=yt-dlp_linux_aarch64 ;; \
        *) echo "no yt-dlp build for this arch" >&2; exit 1 ;; esac \
    && mkdir /opt/yt-dlp \
    && curl -fsSL -o /opt/yt-dlp/yt-dlp \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${asset}" \
    && chmod 755 /opt/yt-dlp/yt-dlp && chown -R herd:herd /opt/yt-dlp \
    && ln -s /opt/yt-dlp/yt-dlp /usr/local/bin/yt-dlp \
    && echo '--js-runtimes node' > /etc/yt-dlp.conf

COPY . .

# Set last so the build steps above don't write caches under /data, which the
# volume mount would hide anyway.
ENV HOME=/data/home

ENTRYPOINT ["/usr/bin/tini", "--", "bash", "/app/scripts/docker-entrypoint.sh"]
