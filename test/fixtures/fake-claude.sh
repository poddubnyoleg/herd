#!/bin/bash
# Stand-in for the claude CLI in test/persistent.test.mjs: drops into a plain
# shell the tests drive with typed commands. A new session writes a minimal
# transcript so Herd's session-id detection binds it, except in a project dir
# named *-unnamed (tests for terminals whose id is never detected).
for a in "$@"; do [ "$a" = "-p" ] && exit 0; done  # Haiku naming calls
resume=""
while [ $# -gt 0 ]; do [ "$1" = "--resume" ] && resume="$2"; shift; done
if [ -z "$resume" ] && [[ "$PWD" != *-unnamed ]]; then
  id=$(uuidgen | tr 'A-Z' 'a-z')
  dir="$HOME/.claude/projects/$(printf %s "$PWD" | sed 's/[^a-zA-Z0-9]/-/g')"
  mkdir -p "$dir"
  printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"user","content":"fake session"}}\n' \
    "$id" "$PWD" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dir/$id.jsonl"
fi
echo "fake-claude ${resume:-new}"
PS1='$ ' exec /bin/zsh -f
