/**
 * Rate limiting middleware for HTTP transport.
 * Implements a sliding window rate limiter per client IP.
 */

import * as http from 'node:http';

export interface RateLimiterOptions {
  /** Maximum requests per minute per IP (default: 60) */
  requestsPerMinute?: number;
  /** Paths that should be excluded from rate limiting (e.g., /health) */
  excludePaths?: string[];
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of remaining requests in the current window */
  remaining: number;
  /** Seconds until the rate limit resets */
  retryAfter?: number;
}

interface RateLimitEntry {
  /** Number of requests in the current window */
  count: number;
  /** Timestamp when the window resets */
  resetTime: number;
}

/**
 * Rate limiter using a sliding window per client IP.
 */
export class RateLimiter {
  private requestsPerMinute: number;
  private windowMs: number;
  private limits: Map<string, RateLimitEntry> = new Map();
  private excludePaths: Set<string>;

  constructor(options: RateLimiterOptions = {}) {
    this.requestsPerMinute = options.requestsPerMinute ??
      parseInt(process.env.MCP_RATE_LIMIT ?? '60', 10);
    this.windowMs = 60 * 1000; // 1 minute window
    this.excludePaths = new Set(options.excludePaths ?? ['/health']);

    // Clean up old entries periodically (every minute)
    setInterval(() => this.cleanup(), this.windowMs);
  }

  /**
   * Check if a request should be rate limited.
   */
  shouldLimit(pathname: string): boolean {
    return !this.excludePaths.has(pathname);
  }

  /**
   * Check the rate limit for a client IP.
   *
   * @param clientIp The client's IP address
   * @returns Rate limit result
   */
  check(clientIp: string): RateLimitResult {
    const now = Date.now();
    let entry = this.limits.get(clientIp);

    // If no entry or window has reset, create new entry
    if (!entry || now >= entry.resetTime) {
      entry = {
        count: 1,
        resetTime: now + this.windowMs,
      };
      this.limits.set(clientIp, entry);
      return {
        allowed: true,
        remaining: this.requestsPerMinute - 1,
      };
    }

    // Increment request count
    entry.count++;

    if (entry.count > this.requestsPerMinute) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfter,
      };
    }

    return {
      allowed: true,
      remaining: this.requestsPerMinute - entry.count,
    };
  }

  /**
   * Handle a rate-limited request by sending a 429 response.
   */
  handleLimited(res: http.ServerResponse, result: RateLimitResult): void {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(result.retryAfter ?? 60),
      'X-RateLimit-Limit': String(this.requestsPerMinute),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(result.retryAfter ?? 60),
    });
    res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
      retryAfter: result.retryAfter,
    }));
  }

  /**
   * Add rate limit headers to a response.
   */
  addHeaders(res: http.ServerResponse, result: RateLimitResult): void {
    res.setHeader('X-RateLimit-Limit', String(this.requestsPerMinute));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (result.retryAfter) {
      res.setHeader('X-RateLimit-Reset', String(result.retryAfter));
    }
  }

  /**
   * Clean up expired entries.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.limits) {
      if (now >= entry.resetTime) {
        this.limits.delete(ip);
      }
    }
  }

  /**
   * Get the current requests per minute limit.
   */
  get limit(): number {
    return this.requestsPerMinute;
  }
}
