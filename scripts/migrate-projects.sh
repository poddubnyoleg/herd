#!/bin/bash
set -euo pipefail

# Migration script: reorganize projects into Personal & Work folders
# Usage: ./scripts/migrate-projects.sh          (dry run)
#        ./scripts/migrate-projects.sh --run     (execute for real)

DRY_RUN=true
if [[ "${1:-}" == "--run" ]]; then
  DRY_RUN=false
fi

HOME_DIR="$HOME"
DOCS="$HOME_DIR/Documents"
PERSONAL="$DOCS/Personal"
WORK="$DOCS/Work"
CLAUDE_PROJECTS="$HOME_DIR/.claude/projects"
GROUPS_JSON="$DOCS/herd/groups.json"
HERD_MOVED=false

log() { echo "  $1"; }
section() { echo ""; echo "=== $1 ==="; }

run() {
  if $DRY_RUN; then
    log "[dry-run] $*"
  else
    log "$*"
    "$@"
  fi
}

move_and_link() {
  local src="$1" dst="$2"
  if [[ ! -e "$src" ]]; then
    log "[skip] $src does not exist"
    return
  fi
  if [[ -e "$dst" ]]; then
    log "[skip] $dst already exists"
    return
  fi
  run mv "$src" "$dst"
  run ln -s "$dst" "$src"
}

rename_session_dir() {
  local old="$CLAUDE_PROJECTS/$1" new="$CLAUDE_PROJECTS/$2"
  if [[ ! -d "$old" ]]; then
    log "[skip] session dir $1 does not exist"
    return
  fi
  if [[ -d "$new" ]]; then
    log "[skip] session dir $2 already exists"
    return
  fi
  run mv "$old" "$new"
}

# -------------------------------------------------------
section "Create target directories"
# -------------------------------------------------------
run mkdir -p "$PERSONAL"
run mkdir -p "$WORK"

# -------------------------------------------------------
section "Move Personal projects"
# -------------------------------------------------------
move_and_link "$DOCS/gpt_meditation"   "$PERSONAL/gpt_meditation"
move_and_link "$DOCS/lightdash_mcp"    "$PERSONAL/lightdash_mcp"
move_and_link "$DOCS/research"         "$PERSONAL/research"
move_and_link "$DOCS/claude-hub"       "$PERSONAL/claude-hub"
move_and_link "$HOME_DIR/health"       "$PERSONAL/health"
move_and_link "$HOME_DIR/gpt_hrv_meditation" "$PERSONAL/gpt_hrv_meditation"
# herd is moved LAST (it's our CWD)

# -------------------------------------------------------
section "Move Work projects (from ~/Documents/sweatcoin/)"
# -------------------------------------------------------
move_and_link "$DOCS/sweatcoin/archie-hq"        "$WORK/archie-hq"
move_and_link "$DOCS/sweatcoin/backend"           "$WORK/backend"
move_and_link "$DOCS/sweatcoin/sweat_brain"       "$WORK/sweat_brain"
move_and_link "$DOCS/sweatcoin/sweat-researcher"  "$WORK/sweat-researcher"
move_and_link "$DOCS/sweatcoin/GPT Diary"         "$WORK/GPT Diary"
move_and_link "$DOCS/sweatcoin/airflow-dags"      "$WORK/airflow-dags"
move_and_link "$DOCS/sweatcoin/bot_meme_collector" "$WORK/bot_meme_collector"
move_and_link "$DOCS/sweatcoin/buybacks"          "$WORK/buybacks"
move_and_link "$DOCS/sweatcoin/data_bot"          "$WORK/data_bot"
move_and_link "$DOCS/sweatcoin/mixtral"           "$WORK/mixtral"
move_and_link "$DOCS/sweatcoin/sweat-comms-engine" "$WORK/sweat-comms-engine"
move_and_link "$DOCS/sweatcoin/sweat-tg-bot"      "$WORK/sweat-tg-bot"
move_and_link "$DOCS/sweatcoin/sweat_looker"      "$WORK/sweat_looker"
move_and_link "$DOCS/sweatcoin/wau-streamlit"     "$WORK/wau-streamlit"

# -------------------------------------------------------
section "Move Work projects (other locations)"
# -------------------------------------------------------
move_and_link "$DOCS/sweat_support_agent"  "$WORK/sweat_support_agent"
move_and_link "$DOCS/wallet-data"          "$WORK/wallet-data"
move_and_link "$DOCS/airflow_dags"         "$WORK/airflow_dags"
move_and_link "$DOCS/sweat-wallet"         "$WORK/sweat-wallet"
move_and_link "$HOME_DIR/sweatcoin-backend" "$WORK/sweatcoin-backend"

# -------------------------------------------------------
section "Move herd (last — this is our CWD)"
# -------------------------------------------------------
move_and_link "$DOCS/herd" "$PERSONAL/herd"
HERD_MOVED=true

# -------------------------------------------------------
section "Rename Claude session directories"
# -------------------------------------------------------
# Personal
rename_session_dir "-Users-pd-Documents-gpt-meditation"     "-Users-pd-Documents-Personal-gpt-meditation"
rename_session_dir "-Users-pd-Documents-herd"               "-Users-pd-Documents-Personal-herd"
rename_session_dir "-Users-pd-Documents-lightdash-mcp"      "-Users-pd-Documents-Personal-lightdash-mcp"
rename_session_dir "-Users-pd-Documents-research"           "-Users-pd-Documents-Personal-research"
rename_session_dir "-Users-pd-Documents-claude-hub"         "-Users-pd-Documents-Personal-claude-hub"
rename_session_dir "-Users-pd-health"                       "-Users-pd-Documents-Personal-health"
rename_session_dir "-Users-pd-gpt-hrv-meditation"           "-Users-pd-Documents-Personal-gpt-hrv-meditation"

# Work
rename_session_dir "-Users-pd-Documents-sweat-support-agent"   "-Users-pd-Documents-Work-sweat-support-agent"
rename_session_dir "-Users-pd-Documents-wallet-data"           "-Users-pd-Documents-Work-wallet-data"
rename_session_dir "-Users-pd-Documents-sweatcoin-archie-hq"   "-Users-pd-Documents-Work-archie-hq"
rename_session_dir "-Users-pd-Documents-sweatcoin-backend"     "-Users-pd-Documents-Work-backend"
rename_session_dir "-Users-pd-Documents-sweatcoin-sweat-brain" "-Users-pd-Documents-Work-sweat-brain"
rename_session_dir "-Users-pd-Documents-sweatcoin-sweat-researcher" "-Users-pd-Documents-Work-sweat-researcher"
rename_session_dir "-Users-pd-Documents-sweatcoin-sweat-researcher-infrastructure-terraform" "-Users-pd-Documents-Work-sweat-researcher-infrastructure-terraform"
rename_session_dir "-Users-pd-Documents-airflow-dags-airflow-dags" "-Users-pd-Documents-Work-airflow-dags-airflow-dags"
rename_session_dir "-Users-pd-Documents-sweat-wallet"          "-Users-pd-Documents-Work-sweat-wallet"
rename_session_dir "-Users-pd-sweatcoin-backend"               "-Users-pd-Documents-Work-sweatcoin-backend"

# -------------------------------------------------------
section "Update groups.json"
# -------------------------------------------------------
# After herd moves, groups.json is at the new location via symlink
NEW_GROUPS_JSON="$PERSONAL/herd/groups.json"
if $HERD_MOVED && ! $DRY_RUN; then
  GROUPS_JSON="$NEW_GROUPS_JSON"
fi

GROUPS_CONTENT='{
  "/Users/pd/Documents/Personal/herd": "personal",
  "/Users/pd/Documents/Personal/research": "personal",
  "/Users/pd/Documents/Personal/claude-hub": "personal",
  "/Users/pd/Documents/Personal/gpt_meditation": "personal",
  "/Users/pd/Documents/Personal/lightdash_mcp": "personal",
  "/Users/pd/Documents/Personal/health": "personal",
  "/Users/pd/Documents/Work/backend": "work",
  "/Users/pd/Documents/Work/sweat-researcher": "work",
  "/Users/pd/Documents/Work/sweat_support_agent": "work",
  "/Users/pd/Documents/Work/wallet-data": "work",
  "/Users/pd/Documents/Work/airflow_dags/airflow-dags": "work",
  "/Users/pd/Documents/Work/archie-hq": "work",
  "/Users/pd/Documents/Work/sweat_brain": "work",
  "/Users/pd/Documents/Work/sweatcoin-backend": "work",
  "/Users/pd/Documents/Work/sweat-researcher/infrastructure/terraform": "work",
  "/Users/pd/Documents/Work/sweat-wallet": "work"
}'

if $DRY_RUN; then
  log "[dry-run] write groups.json:"
  echo "$GROUPS_CONTENT"
else
  echo "$GROUPS_CONTENT" > "$GROUPS_JSON"
  log "wrote $GROUPS_JSON"
fi

# -------------------------------------------------------
section "Done"
# -------------------------------------------------------
if $DRY_RUN; then
  echo ""
  echo "This was a dry run. To execute for real:"
  echo "  bash scripts/migrate-projects.sh --run"
  echo ""
  echo "After running, you will need to:"
  echo "  1. cd ~/Documents/Personal/herd"
  echo "  2. Restart Herd"
else
  echo ""
  echo "Migration complete. Next steps:"
  echo "  1. cd ~/Documents/Personal/herd"
  echo "  2. Restart Herd to pick up new paths"
  echo "  3. Verify: ls ~/Documents/Personal/ ~/Documents/Work/"
fi
