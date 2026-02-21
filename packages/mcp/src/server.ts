import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context, createRegistryFromSnapshot } from "@zilliz/claude-context-core";
import { MilvusVectorDatabase } from "@zilliz/claude-context-core";

// Import our modular components
import { ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";
import { HttpTransport } from "./transports/http-transport.js";
import { validateAuthToken } from "./middleware/auth.js";

// CLI options
export interface CliOptions {
    transport: 'stdio' | 'http' | 'both';
    port: number;
    help: boolean;
}

export class ContextMcpServer {
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

        this.setupTools(this.server);
    }

    /**
     * Create a new MCP Server instance with tools registered.
     * Used by HttpTransport to create per-session servers for concurrent connections.
     */
    private createMcpServer(): Server {
        const server = new Server(
            { name: 'Context MCP Server', version: this.version },
            { capabilities: { tools: {} } }
        );
        this.setupTools(server);
        return server;
    }

    private setupTools(server: Server) {
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
        server.setRequestHandler(ListToolsRequestSchema, async () => {
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
                    {
                        name: "search_all",
                        description: `Search across ALL indexed repositories simultaneously using natural language queries.

🎯 **When to Use**:
- Find code patterns, implementations, or concepts across multiple projects
- Discover how similar functionality is implemented in different repositories
- Locate related code across your entire indexed codebase collection
- Cross-repository code review and analysis

✨ **Features**:
- Fan out query to all indexed collections in parallel
- Normalize scores per collection for fair comparison
- Merge and re-rank results globally
- Results include repository attribution (repoName, repoCanonicalId)

⚠️ **Performance**:
- 5 second timeout per collection
- 15 second total timeout
- Returns top results across all repositories`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for across all indexed repositories"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum total number of results to return (default: 20, max: 50)",
                                    default: 20,
                                    maximum: 50
                                },
                                repos: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Filter to specific repository names or canonical IDs. If not provided, searches all indexed repositories.",
                                    default: []
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results (e.g., ['.ts', '.py']).",
                                    default: []
                                }
                            },
                            required: ["query"]
                        }
                    },
                ]
            };
        });

        // Handle tool execution
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
                case "search_all":
                    return await this.toolHandlers.handleSearchAll(args);

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
            // Validate authentication token is set for HTTP transport
            const authToken = validateAuthToken(cliOptions.transport);

            console.log(`[HTTP] Starting HTTP transport on port ${cliOptions.port}...`);
            this.httpTransport = new HttpTransport({
                port: cliOptions.port,
                mcpServerFactory: () => this.createMcpServer(),
                version: this.version,
                authToken: authToken ?? undefined,
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
