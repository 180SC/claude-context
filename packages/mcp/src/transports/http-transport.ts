/**
 * HTTP transport wrapper for the MCP server.
 * Provides Streamable HTTP transport alongside stdio for network access.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface HttpTransportOptions {
  /** Port to listen on (default: 3100) */
  port: number;
  /** CORS allowed origins (default: '*') */
  corsOrigin?: string;
  /** MCP server instance */
  mcpServer: Server;
  /** Server version for health endpoint */
  version: string;
}

export interface HttpTransportInfo {
  /** Port the server is listening on */
  port: number;
  /** Server start time */
  startTime: Date;
}

/**
 * HTTP transport wrapper that provides:
 * - Streamable HTTP transport on /mcp endpoint
 * - Health check on /health endpoint
 * - CORS support
 */
export class HttpTransport {
  private server: http.Server;
  private mcpServer: Server;
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private port: number;
  private corsOrigin: string;
  private version: string;
  private startTime: Date;

  constructor(options: HttpTransportOptions) {
    this.port = options.port;
    this.corsOrigin = options.corsOrigin ?? '*';
    this.mcpServer = options.mcpServer;
    this.version = options.version;
    this.startTime = new Date();

    this.server = http.createServer(async (req, res) => {
      // Set CORS headers for all responses
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);

      try {
        if (url.pathname === '/health') {
          await this.handleHealthCheck(req, res);
        } else if (url.pathname === '/mcp') {
          await this.handleMcpRequest(req, res);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found' }));
        }
      } catch (error: any) {
        console.error('[HTTP] Error handling request:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          }));
        }
      }
    });
  }

  /**
   * Handle health check requests
   */
  private async handleHealthCheck(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: this.version,
      transport: 'http',
      uptime,
      activeSessions: this.transports.size,
    }));
  }

  /**
   * Handle MCP requests on the /mcp endpoint
   */
  private async handleMcpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    console.log(`[HTTP] Received ${req.method} request to /mcp`);

    // Parse request body for POST requests
    let body: unknown = undefined;
    if (req.method === 'POST') {
      body = await this.parseJsonBody(req);
    }

    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && this.transports.has(sessionId)) {
      // Reuse existing transport
      transport = this.transports.get(sessionId);
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
      // Create new transport for initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          console.log(`[HTTP] Session initialized: ${newSessionId}`);
          if (transport) {
            this.transports.set(newSessionId, transport);
          }
        },
      });

      // Clean up on close
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid && this.transports.has(sid)) {
          console.log(`[HTTP] Session closed: ${sid}`);
          this.transports.delete(sid);
        }
      };

      // Connect transport to MCP server
      await this.mcpServer.connect(transport);
    } else if (sessionId && !this.transports.has(sessionId)) {
      // Invalid session ID
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Session not found',
        },
        id: null,
      }));
      return;
    } else {
      // No session ID and not an initialization request
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      }));
      return;
    }

    // Handle the request with the transport
    if (transport) {
      await transport.handleRequest(req, res, body);
    }
  }

  /**
   * Parse JSON body from request
   */
  private parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : undefined);
        } catch (error) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<HttpTransportInfo> {
    return new Promise((resolve, reject) => {
      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use`));
        } else {
          reject(error);
        }
      });

      this.server.listen(this.port, () => {
        console.log(`[HTTP] MCP HTTP server listening on port ${this.port}`);
        console.log(`[HTTP]   - Health: http://localhost:${this.port}/health`);
        console.log(`[HTTP]   - MCP:    http://localhost:${this.port}/mcp`);
        resolve({
          port: this.port,
          startTime: this.startTime,
        });
      });
    });
  }

  /**
   * Stop the HTTP server and clean up all transports
   */
  async stop(): Promise<void> {
    console.log('[HTTP] Shutting down HTTP server...');

    // Close all active transports
    for (const [sessionId, transport] of this.transports) {
      try {
        console.log(`[HTTP] Closing session ${sessionId}`);
        await transport.close();
      } catch (error) {
        console.error(`[HTTP] Error closing session ${sessionId}:`, error);
      }
    }
    this.transports.clear();

    // Close HTTP server
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          console.log('[HTTP] HTTP server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Get the number of active sessions
   */
  get activeSessions(): number {
    return this.transports.size;
  }
}
