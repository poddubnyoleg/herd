#!/usr/bin/env bash
# Copy of ~/.claude/statusline-command.sh for the Railway container (docs/DEPLOY.md).
# Claude Code status line — model | context used % | 5h rate-limit usage | dir basename | git branch (short)
# Context usage and rate-limit come right after the model so they're never truncated off-screen
# by a long directory path or branch name; dir/branch are kept short and sit last.
input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "Claude"')
raw_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
used_ctx=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
five_used=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_resets=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')

# Directory: basename only (no full path)
cwd=$(basename "$raw_dir" 2>/dev/null)

# Git branch (skip optional locks so Claude's own git activity doesn't block), hard-truncated
branch=""
if [ -n "$raw_dir" ]; then
  branch=$(git -C "$raw_dir" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
  if [ -n "$branch" ] && [ "${#branch}" -gt 12 ]; then
    branch="${branch:0:12}…"
  fi
fi

# Dim ANSI colors (terminal renders status line dimmed)
DIM='\033[2m'
CYAN='\033[2;36m'
GREEN='\033[2;32m'
YELLOW='\033[2;33m'
MAGENTA='\033[2;35m'
RESET='\033[0m'
SEP="$(printf "${DIM} · ${RESET}")"

parts="$(printf "${CYAN}%s${RESET}" "$model")"

if [ -n "$used_ctx" ]; then
  used_ctx_int=$(printf '%.0f' "$used_ctx")
  parts="${parts}${SEP}$(printf "${YELLOW}ctx:%s%%${RESET}" "$used_ctx_int")"
fi

# Current session usage: 5-hour rate-limit window (same figure shown in /usage)
usage=""
if [ -n "$five_used" ]; then
  five_used_int=$(printf '%.0f' "$five_used")
  usage="5h:${five_used_int}%"
  if [ -n "$five_resets" ]; then
    # BSD date (macOS) takes -r <epoch>; GNU date (the Railway container) reads -r as a file
    reset_str=$(date -r "$five_resets" '+%I:%M%p' 2>/dev/null || date -d "@$five_resets" '+%I:%M%p' 2>/dev/null)
    reset_str="${reset_str#0}"
    [ -n "$reset_str" ] && usage="${usage} (resets ${reset_str})"
  fi
fi
if [ -n "$usage" ]; then
  parts="${parts}${SEP}$(printf "${MAGENTA}%s${RESET}" "$usage")"
fi

if [ -n "$cwd" ]; then
  parts="${parts}${SEP}$(printf "${DIM}%s${RESET}" "$cwd")"
fi

if [ -n "$branch" ]; then
  parts="${parts}${SEP}$(printf "${GREEN}%s${RESET}" "$branch")"
fi

printf '%s' "$parts"
