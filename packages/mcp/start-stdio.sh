#!/bin/bash
export PATH="/home/btyeung/.nvm/versions/node/v20.19.4/bin:$PATH"
cd /home/btyeung/Working/claude-context/feature/packages/mcp
exec npx tsx src/index.ts
