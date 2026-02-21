#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { parseArgs } from "node:util";
import { createMcpConfig, logConfigurationSummary, showHelpMessage } from "./config.js";
import { ContextMcpServer, CliOptions } from "./server.js";

function parseCliArgs(): CliOptions {
    const { values } = parseArgs({
        options: {
            transport: {
                type: 'string',
                short: 't',
                default: 'stdio',
            },
            port: {
                type: 'string',
                short: 'p',
                default: process.env.MCP_PORT ?? '3100',
            },
            help: {
                type: 'boolean',
                short: 'h',
                default: false,
            },
        },
        allowPositionals: true,
    });

    const transport = values.transport as string;
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'both') {
        console.error(`Invalid transport: ${transport}. Must be 'stdio', 'http', or 'both'.`);
        process.exit(1);
    }

    return {
        transport: transport as 'stdio' | 'http' | 'both',
        port: parseInt(values.port as string, 10),
        help: values.help as boolean,
    };
}

// Global reference for graceful shutdown
let mcpServer: ContextMcpServer | null = null;

// Main execution
async function main() {
    // Parse command line arguments
    const cliOptions = parseCliArgs();

    // Show help if requested
    if (cliOptions.help) {
        showHelpMessage();
        console.log(`
Transport Options:
  --transport, -t    Transport mode: stdio, http, or both (default: stdio)
  --port, -p         HTTP server port (default: 3100, env: MCP_PORT)

Examples:
  npx @zilliz/claude-context-mcp                        # stdio only (default)
  npx @zilliz/claude-context-mcp --transport http       # HTTP only on port 3100
  npx @zilliz/claude-context-mcp --transport both       # Both stdio and HTTP
  npx @zilliz/claude-context-mcp -t http -p 8080        # HTTP on port 8080
`);
        process.exit(0);
    }

    // Create configuration
    const config = createMcpConfig();
    logConfigurationSummary(config);

    mcpServer = new ContextMcpServer(config);
    await mcpServer.start(cliOptions);
}

// Handle graceful shutdown
async function gracefulShutdown(signal: string) {
    console.error(`Received ${signal}, shutting down gracefully...`);
    if (mcpServer) {
        try {
            await mcpServer.stop();
        } catch (error) {
            console.error('Error during shutdown:', error);
        }
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
