#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context, createRegistryFromSnapshot } from "@zilliz/claude-context-core";
import { MilvusVectorDatabase } from "@zilliz/claude-context-core";

// Import our modular components
import { createMcpConfig, logConfigurationSummary, showHelpMessage, ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";
import { HttpTransport } from "./transports/http-transport.js";

// CLI options
interface CliOptions {
    transport: 'stdio' | 'http' | 'both';
    port: number;
    help: boolean;
}

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

class ContextMcpServer {
    private server: Server;
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;
    private httpTransport: HttpTransport | null = null;
    private version: string;

    constructor(config: ContextMcpConfig) {
        this.version = config.version;
        // Initialize MCP server
        this.server = new Server(
            {
                name: config.name,
                version: config.version
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Initialize embedding provider
        console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
        console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

        const embedding = createEmbeddingInstance(config);
        logEmbeddingProviderInfo(config, embedding);

        // Initialize vector database
        const vectorDatabase = new MilvusVectorDatabase({
            address: config.milvusAddress,
            ...(config.milvusToken && { token: config.milvusToken })
        });

        // Initialize Claude Context
        this.context = new Context({
            embedding,
            vectorDatabase
        });

        // Initialize managers
        this.snapshotManager = new SnapshotManager();
        this.syncManager = new SyncManager(this.context, this.snapshotManager);

        // Load existing codebase snapshot on startup
        this.snapshotManager.loadCodebaseSnapshot();

        // Initialize repository registry from snapshot data
        const repositories = this.snapshotManager.getAllRepositories();
        const repositoriesRecord: Record<string, any> = {};
        for (const [canonicalId, repo] of repositories) {
            repositoriesRecord[canonicalId] = repo;
        }
        const registry = createRegistryFromSnapshot(repositoriesRecord);
        console.log(`[REGISTRY] Initialized registry with ${registry.size} repositories (${registry.listIndexed().length} indexed)`);

        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager, registry);

        this.setupTools();
    }

    private setupTools() {
        const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;


        const search_description = `
Search the indexed codebase using natural language queries within a specified absolute path.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.

🎯 **When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first.
- You can then use the index_codebase tool to index the codebase before searching again.
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "index_codebase",
                        description: index_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to index.`
                                },
                                force: {
                                    type: "boolean",
                                    description: "Force re-indexing even if already indexed",
                                    default: false
                                },
                                splitter: {
                                    type: "string",
                                    description: "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                                    enum: ["ast", "langchain"],
                                    default: "ast"
                                },
                                customExtensions: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                    default: []
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                    default: []
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the codebase"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                }
                            },
                            required: ["path", "query"]
                        }
                    },
                    {
                        name: "clear_index",
                        description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to clear.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to check status for.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                ]
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            switch (name) {
                case "index_codebase":
                    return await this.toolHandlers.handleIndexCodebase(args);
                case "search_code":
                    return await this.toolHandlers.handleSearchCode(args);
                case "clear_index":
                    return await this.toolHandlers.handleClearIndex(args);
                case "get_indexing_status":
                    return await this.toolHandlers.handleGetIndexingStatus(args);

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start(cliOptions: CliOptions) {
        console.log('[SYNC-DEBUG] MCP server start() method called');
        console.log('Starting Context MCP server...');
        console.log(`[TRANSPORT] Mode: ${cliOptions.transport}`);

        const useStdio = cliOptions.transport === 'stdio' || cliOptions.transport === 'both';
        const useHttp = cliOptions.transport === 'http' || cliOptions.transport === 'both';

        // Start HTTP transport if requested
        if (useHttp) {
            console.log(`[HTTP] Starting HTTP transport on port ${cliOptions.port}...`);
            this.httpTransport = new HttpTransport({
                port: cliOptions.port,
                mcpServer: this.server,
                version: this.version,
            });
            await this.httpTransport.start();
        }

        // Start stdio transport if requested
        if (useStdio) {
            const stdioTransport = new StdioServerTransport();
            console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');
            await this.server.connect(stdioTransport);
            console.log("MCP server started and listening on stdio.");
            console.log('[SYNC-DEBUG] Server connection established successfully');
        }

        // Start background sync after server is connected
        console.log('[SYNC-DEBUG] Initializing background sync...');
        this.syncManager.startBackgroundSync();
        console.log('[SYNC-DEBUG] MCP server initialization complete');
    }

    async stop() {
        console.log('[SHUTDOWN] Stopping MCP server...');
        if (this.httpTransport) {
            await this.httpTransport.stop();
        }
        await this.server.close();
        console.log('[SHUTDOWN] MCP server stopped');
    }

    /**
     * Expose the MCP Server instance for external use
     */
    getMcpServer(): Server {
        return this.server;
    }
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