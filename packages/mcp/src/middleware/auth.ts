/**
 * Authentication middleware for HTTP transport.
 * Implements bearer token authentication for secure network access.
 */

import * as http from 'node:http';

export interface AuthMiddlewareOptions {
  /** The bearer token required for authentication */
  token: string;
  /** Paths that should be excluded from authentication (e.g., /health) */
  excludePaths?: string[];
}

export interface AuthResult {
  /** Whether authentication was successful */
  authenticated: boolean;
  /** Error message if authentication failed */
  error?: string;
  /** HTTP status code to return if authentication failed */
  statusCode?: number;
}

/**
 * Authentication middleware for bearer token validation.
 */
export class AuthMiddleware {
  private token: string;
  private excludePaths: Set<string>;

  constructor(options: AuthMiddlewareOptions) {
    this.token = options.token;
    this.excludePaths = new Set(options.excludePaths ?? ['/health']);
  }

  /**
   * Check if a request requires authentication.
   */
  requiresAuth(pathname: string): boolean {
    return !this.excludePaths.has(pathname);
  }

  /**
   * Authenticate a request.
   *
   * @param req The incoming HTTP request
   * @returns Authentication result
   */
  authenticate(req: http.IncomingMessage): AuthResult {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return {
        authenticated: false,
        error: 'Authorization header required',
        statusCode: 401,
      };
    }

    // Parse Bearer token
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return {
        authenticated: false,
        error: 'Invalid authorization format. Use: Bearer <token>',
        statusCode: 401,
      };
    }

    const providedToken = parts[1];
    if (providedToken !== this.token) {
      return {
        authenticated: false,
        error: 'Invalid token',
        statusCode: 401,
      };
    }

    return { authenticated: true };
  }

  /**
   * Handle an unauthenticated request by sending an error response.
   */
  handleUnauthorized(res: http.ServerResponse, result: AuthResult): void {
    res.writeHead(result.statusCode ?? 401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="MCP Server"',
    });
    res.end(JSON.stringify({
      error: 'Unauthorized',
      message: result.error,
    }));
  }

  /**
   * Get the client IP address from a request.
   */
  static getClientIp(req: http.IncomingMessage): string {
    // Check X-Forwarded-For header first (for proxied requests)
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : forwardedFor.split(',')[0].trim();
      return ips;
    }

    // Fall back to socket remote address
    return req.socket.remoteAddress ?? 'unknown';
  }
}

/**
 * Validate that MCP_AUTH_TOKEN is set when HTTP transport is enabled.
 * Returns the token if valid, or throws an error if not set.
 */
export function validateAuthToken(transportMode: 'stdio' | 'http' | 'both'): string | null {
  if (transportMode === 'stdio') {
    // No authentication needed for stdio-only mode
    return null;
  }

  const token = process.env.MCP_AUTH_TOKEN;

  if (!token || token.trim() === '') {
    console.error('[AUTH] ERROR: MCP_AUTH_TOKEN environment variable is required when using HTTP transport.');
    console.error('[AUTH] Set MCP_AUTH_TOKEN to a secure random value before starting the server.');
    console.error('[AUTH] Example: MCP_AUTH_TOKEN=$(openssl rand -hex 32) npx @zilliz/claude-context-mcp --transport http');
    process.exit(2);
  }

  return token;
}
