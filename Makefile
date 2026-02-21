# Load .env file if it exists
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

.PHONY: install build serve serve-stdio serve-both health stop clean test-auth

# Install dependencies
install:
	pnpm install

# Build the project
build:
	pnpm build

# Start HTTP server (default port 3100)
serve:
	cd packages/mcp && pnpm start --transport http --port $(or $(MCP_PORT),3100)

# Start stdio server (for local MCP clients)
serve-stdio:
	cd packages/mcp && pnpm start --transport stdio

# Start both HTTP and stdio
serve-both:
	cd packages/mcp && pnpm start --transport both --port $(or $(MCP_PORT),3100)

# Check server health
health:
	@curl -s http://localhost:$(or $(MCP_PORT),3100)/health | jq .

# Stop any server running on MCP_PORT
stop:
	@lsof -ti:$(or $(MCP_PORT),3100) | xargs kill 2>/dev/null || echo "No server running on port $(or $(MCP_PORT),3100)"

# Clean build artifacts
clean:
	pnpm -r clean

# Test authentication
test-auth:
	@echo "=== Without token (should fail) ==="
	@curl -s http://localhost:$(or $(MCP_PORT),3100)/mcp | jq .
	@echo ""
	@echo "=== With token (should work) ==="
	@curl -s http://localhost:$(or $(MCP_PORT),3100)/mcp \
		-H "Authorization: Bearer $(MCP_AUTH_TOKEN)" \
		-H "Content-Type: application/json" \
		-X POST \
		-d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0"}},"id":1}' | jq .
