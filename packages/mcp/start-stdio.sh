#!/bin/bash
# Start MCP server from source for use in ~/.claude.json stdio config.
# Requires Node 20+ — uses nvm if available.
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh"
    nvm use 20 --silent 2>/dev/null
fi
exec node "$DIR/dist/cli.js" "$@"
