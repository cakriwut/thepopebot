#!/bin/bash
set -e

# Git setup - derive identity from GitHub token
gh auth setup-git
GH_USER_JSON=$(gh api user -q '{name: .name, login: .login, email: .email, id: .id}')
GH_USER_NAME=$(echo "$GH_USER_JSON" | jq -r '.name // .login')
GH_USER_EMAIL=$(echo "$GH_USER_JSON" | jq -r '.email // "\(.id)+\(.login)@users.noreply.github.com"')
git config --global user.name "$GH_USER_NAME"
git config --global user.email "$GH_USER_EMAIL"

# Clone repo (skip if already cloned — enables docker restart)
if [ -n "$REPO" ] && [ ! -d "/home/claude-code/workspace/.git" ]; then
    git clone --branch "$BRANCH" "https://github.com/$REPO" /home/claude-code/workspace
fi

cd /home/claude-code/workspace
WORKSPACE_DIR=$(pwd)

# Claude Code auth — use OAuth token, not API key
unset ANTHROPIC_API_KEY
export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"

# Skip onboarding and trust dialogs
mkdir -p ~/.claude
cat > ~/.claude/settings.json << 'EOF'
{
  "theme": "dark",
  "hasTrustDialogAccepted": true,
  "skipDangerousModePermissionPrompt": true
}
EOF

cat > ~/.claude.json << ENDJSON
{
  "hasCompletedOnboarding": true,
  "projects": {
    "${WORKSPACE_DIR}": {
      "allowedTools": [],
      "hasTrustDialogAccepted": true,
      "hasTrustDialogHooksAccepted": true
    }
  }
}
ENDJSON

# Start Claude Code in a tmux session
tmux -u new-session -d -s claude 'claude --dangerously-skip-permissions'

# Start ttyd in foreground (PID 1) — serves tmux over WebSocket
exec ttyd --writable -p "${PORT:-7681}" tmux attach -t claude
