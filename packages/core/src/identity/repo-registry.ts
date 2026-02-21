/**
 * Repository Registry
 *
 * Maps multiple filesystem paths to their canonical repository identity,
 * preventing duplicate indexing across worktrees and clones.
 *
 * This is a thin layer on top of the v3 snapshot that provides
 * lookup-by-identity behavior for the MCP handlers.
 */

import * as path from 'path';
import { resolveIdentity, RepoIdentity } from './repo-identity';

/**
 * Repository record stored in the registry.
 */
export interface RepoRecord {
  /** The canonical repository ID */
  canonicalId: string;
  /** Human-readable name for the repository */
  displayName: string;
  /** Normalized remote URL if available (e.g., "github.com/user/repo") */
  remoteUrl?: string;
  /** How the canonical ID was determined */
  identitySource: 'remote-url' | 'initial-commit' | 'path-hash';
  /** All known filesystem paths that map to this repository */
  knownPaths: string[];
  /** Paths that are git worktrees */
  worktrees: string[];
  /** Whether this repository has an active index */
  isIndexed: boolean;
  /** The collection name in the vector database, if indexed */
  collectionName?: string;
  /** Timestamp of last indexing activity */
  lastIndexed?: string;
  /** Number of files indexed */
  indexedFiles?: number;
  /** Total chunks in the index */
  totalChunks?: number;
}

/**
 * Result of resolving a path in the registry.
 */
export interface ResolveResult {
  /** Whether the path was found in the registry */
  found: boolean;
  /** The repository record if found */
  record?: RepoRecord;
  /** The resolved identity (even if not in registry) */
  identity: RepoIdentity;
  /** Whether this is a new path for an existing repo */
  isNewPathForExistingRepo: boolean;
  /** The primary path (first registered) for this repo */
  primaryPath?: string;
}

/**
 * Options for registering a path.
 */
export interface RegisterOptions {
  /** The collection name to associate with this repo */
  collectionName?: string;
  /** Mark as indexed */
  isIndexed?: boolean;
  /** Number of indexed files */
  indexedFiles?: number;
  /** Total chunks */
  totalChunks?: number;
}

/**
 * Repository registry that maps filesystem paths to canonical identities.
 *
 * The registry is designed to work with the v3 snapshot format and provides
 * the gatekeeper logic for `index_codebase` operations.
 *
 * @example
 * const registry = new RepoRegistry();
 *
 * // Check if a path is already indexed
 * const result = registry.resolve('/path/to/worktree');
 * if (result.found && result.record?.isIndexed) {
 *   console.log('Already indexed as:', result.record.displayName);
 * }
 *
 * // Register a new path after indexing
 * registry.register('/path/to/repo', { isIndexed: true, collectionName: 'abc123' });
 */
export class RepoRegistry {
  /** Repository records keyed by canonical ID */
  private repositories: Map<string, RepoRecord> = new Map();

  /** Path to canonical ID mapping for quick lookups */
  private pathToCanonicalId: Map<string, string> = new Map();

  /**
   * Create a new RepoRegistry.
   * Optionally initialize with existing repository records.
   */
  constructor(initialRecords?: Map<string, RepoRecord>) {
    if (initialRecords) {
      for (const [canonicalId, record] of initialRecords) {
        this.repositories.set(canonicalId, record);
        for (const knownPath of record.knownPaths) {
          this.pathToCanonicalId.set(knownPath, canonicalId);
        }
      }
    }
  }

  /**
   * Resolve a filesystem path to its registry record.
   *
   * This method:
   * 1. Resolves the path's canonical identity (using git identity detection)
   * 2. Checks if the canonical ID is already in the registry
   * 3. Returns information about whether this is a new or existing repo
   *
   * @param targetPath The filesystem path to resolve
   * @returns Resolution result with identity and registry info
   */
  resolve(targetPath: string): ResolveResult {
    const normalizedPath = path.resolve(targetPath);
    const identity = resolveIdentity(normalizedPath);
    const canonicalId = identity.canonicalId;

    // Check if this path is directly registered
    const directCanonicalId = this.pathToCanonicalId.get(normalizedPath);
    if (directCanonicalId) {
      const record = this.repositories.get(directCanonicalId)!;
      return {
        found: true,
        record,
        identity,
        isNewPathForExistingRepo: false,
        primaryPath: record.knownPaths[0],
      };
    }

    // Check if the canonical ID is registered (different path, same repo)
    const existingRecord = this.repositories.get(canonicalId);
    if (existingRecord) {
      return {
        found: true,
        record: existingRecord,
        identity,
        isNewPathForExistingRepo: true,
        primaryPath: existingRecord.knownPaths[0],
      };
    }

    // Not in registry
    return {
      found: false,
      identity,
      isNewPathForExistingRepo: false,
    };
  }

  /**
   * Register a path in the registry.
   *
   * If the canonical ID already exists, the path is added to the existing record.
   * Otherwise, a new record is created.
   *
   * @param targetPath The filesystem path to register
   * @param options Optional registration options
   * @returns The repository record (new or updated)
   */
  register(targetPath: string, options: RegisterOptions = {}): RepoRecord {
    const normalizedPath = path.resolve(targetPath);
    const identity = resolveIdentity(normalizedPath);
    const canonicalId = identity.canonicalId;

    let record = this.repositories.get(canonicalId);

    if (record) {
      // Update existing record
      if (!record.knownPaths.includes(normalizedPath)) {
        record.knownPaths.push(normalizedPath);
        this.pathToCanonicalId.set(normalizedPath, canonicalId);
      }

      // Check if this is a worktree
      if (identity.isWorktree && !record.worktrees.includes(normalizedPath)) {
        record.worktrees.push(normalizedPath);
      }

      // Update indexing info if provided
      if (options.collectionName !== undefined) {
        record.collectionName = options.collectionName;
      }
      if (options.isIndexed !== undefined) {
        record.isIndexed = options.isIndexed;
        if (options.isIndexed) {
          record.lastIndexed = new Date().toISOString();
        }
      }
      if (options.indexedFiles !== undefined) {
        record.indexedFiles = options.indexedFiles;
      }
      if (options.totalChunks !== undefined) {
        record.totalChunks = options.totalChunks;
      }
    } else {
      // Create new record
      record = {
        canonicalId,
        displayName: identity.displayName,
        remoteUrl: identity.remoteUrl,
        identitySource: identity.identitySource,
        knownPaths: [normalizedPath],
        worktrees: identity.isWorktree ? [normalizedPath] : [],
        isIndexed: options.isIndexed ?? false,
        collectionName: options.collectionName,
        lastIndexed: options.isIndexed ? new Date().toISOString() : undefined,
        indexedFiles: options.indexedFiles,
        totalChunks: options.totalChunks,
      };

      this.repositories.set(canonicalId, record);
      this.pathToCanonicalId.set(normalizedPath, canonicalId);
    }

    return record;
  }

  /**
   * Check if a repository (by canonical identity) is already indexed.
   *
   * @param identity The repository identity to check
   * @returns True if the canonical ID has an active index
   */
  isAlreadyIndexed(identity: RepoIdentity): boolean {
    const record = this.repositories.get(identity.canonicalId);
    return record?.isIndexed ?? false;
  }

  /**
   * Check if a path leads to an already-indexed repository.
   *
   * @param targetPath The filesystem path to check
   * @returns True if this path's repository is already indexed
   */
  isPathAlreadyIndexed(targetPath: string): boolean {
    const result = this.resolve(targetPath);
    return result.found && (result.record?.isIndexed ?? false);
  }

  /**
   * Get a repository record by canonical ID.
   *
   * @param canonicalId The canonical repository ID
   * @returns The repository record, or undefined if not found
   */
  getByCanonicalId(canonicalId: string): RepoRecord | undefined {
    return this.repositories.get(canonicalId);
  }

  /**
   * Get a repository record by filesystem path.
   *
   * @param targetPath The filesystem path
   * @returns The repository record, or undefined if not found
   */
  getByPath(targetPath: string): RepoRecord | undefined {
    const normalizedPath = path.resolve(targetPath);
    const canonicalId = this.pathToCanonicalId.get(normalizedPath);
    if (canonicalId) {
      return this.repositories.get(canonicalId);
    }

    // Try resolving identity in case the exact path isn't registered
    // but the same repo (by canonical ID) is
    const identity = resolveIdentity(normalizedPath);
    return this.repositories.get(identity.canonicalId);
  }

  /**
   * List all registered repositories.
   *
   * @returns Array of all repository records
   */
  listAll(): RepoRecord[] {
    return Array.from(this.repositories.values());
  }

  /**
   * List all indexed repositories.
   *
   * @returns Array of indexed repository records
   */
  listIndexed(): RepoRecord[] {
    return this.listAll().filter(r => r.isIndexed);
  }

  /**
   * Mark a repository as indexed.
   *
   * @param canonicalId The canonical repository ID
   * @param indexInfo Indexing information
   */
  markIndexed(
    canonicalId: string,
    indexInfo: { collectionName: string; indexedFiles: number; totalChunks: number }
  ): void {
    const record = this.repositories.get(canonicalId);
    if (record) {
      record.isIndexed = true;
      record.collectionName = indexInfo.collectionName;
      record.indexedFiles = indexInfo.indexedFiles;
      record.totalChunks = indexInfo.totalChunks;
      record.lastIndexed = new Date().toISOString();
    }
  }

  /**
   * Mark a repository as not indexed (e.g., after clearing the index).
   *
   * @param canonicalId The canonical repository ID
   */
  markNotIndexed(canonicalId: string): void {
    const record = this.repositories.get(canonicalId);
    if (record) {
      record.isIndexed = false;
      record.collectionName = undefined;
      record.indexedFiles = undefined;
      record.totalChunks = undefined;
    }
  }

  /**
   * Remove a path from the registry.
   * If this is the last path for a repo, the entire record is removed.
   *
   * @param targetPath The filesystem path to remove
   * @returns True if the path was found and removed
   */
  removePath(targetPath: string): boolean {
    const normalizedPath = path.resolve(targetPath);
    const canonicalId = this.pathToCanonicalId.get(normalizedPath);

    if (!canonicalId) {
      return false;
    }

    this.pathToCanonicalId.delete(normalizedPath);

    const record = this.repositories.get(canonicalId);
    if (record) {
      record.knownPaths = record.knownPaths.filter(p => p !== normalizedPath);
      record.worktrees = record.worktrees.filter(p => p !== normalizedPath);

      // If no paths left, remove the entire record
      if (record.knownPaths.length === 0) {
        this.repositories.delete(canonicalId);
      }
    }

    return true;
  }

  /**
   * Remove a repository by canonical ID.
   *
   * @param canonicalId The canonical repository ID
   * @returns True if the repository was found and removed
   */
  removeByCanonicalId(canonicalId: string): boolean {
    const record = this.repositories.get(canonicalId);
    if (!record) {
      return false;
    }

    // Remove all path mappings
    for (const knownPath of record.knownPaths) {
      this.pathToCanonicalId.delete(knownPath);
    }

    this.repositories.delete(canonicalId);
    return true;
  }

  /**
   * Get the number of registered repositories.
   */
  get size(): number {
    return this.repositories.size;
  }

  /**
   * Get the internal repositories map (for snapshot persistence).
   */
  getRepositoriesMap(): Map<string, RepoRecord> {
    return new Map(this.repositories);
  }

  /**
   * Clear all registry data.
   */
  clear(): void {
    this.repositories.clear();
    this.pathToCanonicalId.clear();
  }
}

/**
 * Create a RepoRegistry from a v3 snapshot's repositories.
 *
 * @param repositories The repositories record from a v3 snapshot
 * @returns A RepoRegistry initialized with the snapshot data
 */
export function createRegistryFromSnapshot(
  repositories: Record<string, {
    displayName: string;
    remoteUrl?: string;
    identitySource: 'remote-url' | 'initial-commit' | 'path-hash';
    knownPaths: string[];
    worktrees: string[];
    branches: Record<string, { status: string; indexedFiles: number; totalChunks: number }>;
    defaultBranch?: string;
    lastIndexed: string;
    collectionName?: string;
  }>
): RepoRegistry {
  const records = new Map<string, RepoRecord>();

  for (const [canonicalId, repo] of Object.entries(repositories)) {
    const defaultBranch = repo.branches[repo.defaultBranch || 'default'];
    const isIndexed = defaultBranch?.status === 'indexed';

    records.set(canonicalId, {
      canonicalId,
      displayName: repo.displayName,
      remoteUrl: repo.remoteUrl,
      identitySource: repo.identitySource,
      knownPaths: repo.knownPaths,
      worktrees: repo.worktrees,
      isIndexed,
      collectionName: repo.collectionName,
      lastIndexed: isIndexed ? repo.lastIndexed : undefined,
      indexedFiles: isIndexed ? defaultBranch.indexedFiles : undefined,
      totalChunks: isIndexed ? defaultBranch.totalChunks : undefined,
    });
  }

  return new RepoRegistry(records);
}
