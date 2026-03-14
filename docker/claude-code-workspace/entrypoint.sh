#!/bin/bash
set -e

# Git setup - derive identity from GitHub token
gh auth setup-git
GH_USER_JSON=$(gh api user -q '{name: .name, login: .login, email: .email, id: .id}')
GH_USER_NAME=$(echo "$GH_USER_JSON" | jq -r '.name // .login')
GH_USER_EMAIL=$(echo "$GH_USER_JSON" | jq -r '.email // "\(.id)+\(.login)@users.noreply.github.com"')
git config --global user.name "$GH_USER_NAME"
git config --global user.email "$GH_USER_EMAIL"

cd /home/claude-code/workspace

# Clone if volume is empty, otherwise reset to clean state
if [ ! -d ".git" ]; then
    git clone --branch "$BRANCH" "https://github.com/$REPO" .
else
    git fetch origin
    git checkout "$BRANCH"
    git reset --hard "origin/$BRANCH"
    git clean -fd
fi

# Checkout feature branch (create or reset)
if [ -n "$FEATURE_BRANCH" ]; then
    if git ls-remote --heads origin "$FEATURE_BRANCH" | grep -q .; then
        git checkout -B "$FEATURE_BRANCH" "origin/$FEATURE_BRANCH"
    else
        git checkout -b "$FEATURE_BRANCH"
        git push -u origin "$FEATURE_BRANCH"
    fi
fi

WORKSPACE_DIR=$(pwd)

# Write chat context file if provided — raw JSON with framing text
if [ -n "$CHAT_CONTEXT" ]; then
    mkdir -p .claude
    cat > .claude/chat-context.txt << 'CTXHEADER'
The following is a previous planning conversation between the user and an AI assistant. The user has now switched to this interactive coding session to continue working on this task. Use this conversation as context.

CTXHEADER
    echo "$CHAT_CONTEXT" >> .claude/chat-context.txt
fi

# Claude Code auth — use OAuth token, not API key
unset ANTHROPIC_API_KEY
export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"

# Skip onboarding and trust dialogs
mkdir -p ~/.claude

if [ -f "${WORKSPACE_DIR}/.claude/chat-context.txt" ]; then
    cat > ~/.claude/settings.json << SETTINGSEOF
{
  "theme": "dark",
  "hasTrustDialogAccepted": true,
  "skipDangerousModePermissionPrompt": true,
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cat ${WORKSPACE_DIR}/.claude/chat-context.txt"
          }
        ]
      }
    ]
  }
}
SETTINGSEOF
else
    cat > ~/.claude/settings.json << 'EOF'
{
  "theme": "dark",
  "hasTrustDialogAccepted": true,
  "skipDangerousModePermissionPrompt": true
}
EOF
fi

cat > ~/.claude.json << ENDJSON
{
  "hasCompletedOnboarding": true,
  "projects": {
    "${WORKSPACE_DIR}": {
      "allowedTools": ["WebSearch"],
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
