/**
 * Collection name migration module.
 *
 * Handles the migration from path-based collection naming (8-char hash)
 * to canonical-identity-based naming (12-char hash) with backward compatibility.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveIdentity, RepoIdentity } from './repo-identity';

/**
 * Represents a migration mapping from old to new collection name.
 */
export interface CollectionMigrationMapping {
  /** The old collection name (8-char path hash) */
  oldName: string;
  /** The new collection name (12-char canonical ID hash) */
  newName: string;
  /** The canonical repository ID */
  canonicalId: string;
  /** The original filesystem path */
  path: string;
  /** When the mapping was created */
  createdAt: string;
  /** Whether the migration has been completed */
  migrated: boolean;
  /** When the migration was completed, if applicable */
  migratedAt?: string;
}

/**
 * Migration state stored in ~/.context/collection-migration.json
 */
export interface CollectionMigrationState {
  version: 'v1';
  mappings: CollectionMigrationMapping[];
  lastUpdated: string;
}

/**
 * Result of resolving a collection name with identity awareness.
 */
export interface CollectionNameResolution {
  /** The collection name to use */
  collectionName: string;
  /** Whether this is a legacy (path-based) name */
  isLegacy: boolean;
  /** The canonical repository identity, if resolved */
  identity?: RepoIdentity;
  /** The legacy collection name, if different from the resolved name */
  legacyName?: string;
  /** The new canonical-ID-based name, if different from the resolved name */
  canonicalName?: string;
}

const MIGRATION_FILE_PATH = path.join(os.homedir(), '.context', 'collection-migration.json');

/**
 * Generate a legacy collection name from an absolute path.
 * This matches the original implementation: md5(absolutePath).substring(0, 8)
 */
export function generateLegacyCollectionName(
  codebasePath: string,
  isHybrid: boolean = true
): string {
  const normalizedPath = path.resolve(codebasePath);
  const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
  const prefix = isHybrid ? 'hybrid_code_chunks' : 'code_chunks';
  return `${prefix}_${hash.substring(0, 8)}`;
}

/**
 * Generate a new collection name from a canonical repository ID.
 * Uses 12-char hash for lower collision risk across repos.
 */
export function generateCanonicalCollectionName(
  canonicalId: string,
  isHybrid: boolean = true
): string {
  const hash = crypto.createHash('md5').update(canonicalId).digest('hex');
  const prefix = isHybrid ? 'hybrid_code_chunks' : 'code_chunks';
  return `${prefix}_${hash.substring(0, 12)}`;
}

/**
 * Generate both legacy and canonical collection names for a path.
 */
export function generateCollectionNames(
  codebasePath: string,
  isHybrid: boolean = true
): { legacyName: string; canonicalName: string; identity: RepoIdentity } {
  const identity = resolveIdentity(codebasePath);
  const legacyName = generateLegacyCollectionName(codebasePath, isHybrid);
  const canonicalName = generateCanonicalCollectionName(identity.canonicalId, isHybrid);

  return { legacyName, canonicalName, identity };
}

/**
 * Load migration state from the file system.
 */
export function loadMigrationState(): CollectionMigrationState {
  try {
    if (fs.existsSync(MIGRATION_FILE_PATH)) {
      const content = fs.readFileSync(MIGRATION_FILE_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn('[MIGRATION] Failed to load migration state:', error);
  }

  return {
    version: 'v1',
    mappings: [],
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Save migration state to the file system.
 */
export function saveMigrationState(state: CollectionMigrationState): void {
  try {
    const dir = path.dirname(MIGRATION_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(MIGRATION_FILE_PATH, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[MIGRATION] Failed to save migration state:', error);
  }
}

/**
 * Add a migration mapping to the state.
 */
export function addMigrationMapping(
  state: CollectionMigrationState,
  mapping: Omit<CollectionMigrationMapping, 'createdAt' | 'migrated'>
): CollectionMigrationState {
  // Check if mapping already exists
  const existingIndex = state.mappings.findIndex(
    (m) => m.oldName === mapping.oldName || m.path === mapping.path
  );

  const newMapping: CollectionMigrationMapping = {
    ...mapping,
    createdAt: new Date().toISOString(),
    migrated: false,
  };

  if (existingIndex >= 0) {
    // Update existing mapping
    state.mappings[existingIndex] = {
      ...state.mappings[existingIndex],
      ...newMapping,
    };
  } else {
    state.mappings.push(newMapping);
  }

  return state;
}

/**
 * Mark a mapping as migrated.
 */
export function markMigrationComplete(
  state: CollectionMigrationState,
  oldName: string
): CollectionMigrationState {
  const mapping = state.mappings.find((m) => m.oldName === oldName);
  if (mapping) {
    mapping.migrated = true;
    mapping.migratedAt = new Date().toISOString();
  }
  return state;
}

/**
 * Find a mapping by legacy collection name.
 */
export function findMappingByLegacyName(
  state: CollectionMigrationState,
  legacyName: string
): CollectionMigrationMapping | undefined {
  return state.mappings.find((m) => m.oldName === legacyName);
}

/**
 * Find a mapping by path.
 */
export function findMappingByPath(
  state: CollectionMigrationState,
  codebasePath: string
): CollectionMigrationMapping | undefined {
  const normalizedPath = path.resolve(codebasePath);
  return state.mappings.find((m) => m.path === normalizedPath);
}

/**
 * Find a mapping by canonical ID.
 */
export function findMappingByCanonicalId(
  state: CollectionMigrationState,
  canonicalId: string
): CollectionMigrationMapping | undefined {
  return state.mappings.find((m) => m.canonicalId === canonicalId);
}

/**
 * Get all unmigrated mappings.
 */
export function getUnmigratedMappings(
  state: CollectionMigrationState
): CollectionMigrationMapping[] {
  return state.mappings.filter((m) => !m.migrated);
}

/**
 * Manages collection name resolution with migration support.
 */
export class CollectionMigrator {
  private state: CollectionMigrationState;
  private existingCollections: Set<string> = new Set();

  constructor() {
    this.state = loadMigrationState();
  }

  /**
   * Set the list of existing collections in the vector database.
   * This should be called with the result of listCollections() on startup.
   */
  setExistingCollections(collections: string[]): void {
    this.existingCollections = new Set(collections);
  }

  /**
   * Check if a collection exists.
   */
  hasCollection(collectionName: string): boolean {
    return this.existingCollections.has(collectionName);
  }

  /**
   * Add a collection to the existing set (call after creating a new collection).
   */
  addCollection(collectionName: string): void {
    this.existingCollections.add(collectionName);
  }

  /**
   * Remove a collection from the existing set (call after dropping a collection).
   */
  removeCollection(collectionName: string): void {
    this.existingCollections.delete(collectionName);
  }

  /**
   * Resolve the collection name for a codebase path.
   *
   * Strategy:
   * 1. If a legacy (8-char) collection exists for this path, use it (backward compat)
   * 2. If no legacy collection exists, use canonical-ID-based name (12-char)
   * 3. Track the mapping for future migration
   */
  resolveCollectionName(
    codebasePath: string,
    isHybrid: boolean = true
  ): CollectionNameResolution {
    const { legacyName, canonicalName, identity } = generateCollectionNames(
      codebasePath,
      isHybrid
    );

    // Check if legacy collection exists
    if (this.hasCollection(legacyName)) {
      // Track the mapping for future migration
      this.state = addMigrationMapping(this.state, {
        oldName: legacyName,
        newName: canonicalName,
        canonicalId: identity.canonicalId,
        path: path.resolve(codebasePath),
      });
      saveMigrationState(this.state);

      return {
        collectionName: legacyName,
        isLegacy: true,
        identity,
        legacyName,
        canonicalName,
      };
    }

    // Check if canonical collection exists (maybe already migrated)
    if (this.hasCollection(canonicalName)) {
      return {
        collectionName: canonicalName,
        isLegacy: false,
        identity,
        legacyName,
        canonicalName,
      };
    }

    // New collection - use canonical name
    return {
      collectionName: canonicalName,
      isLegacy: false,
      identity,
      legacyName,
      canonicalName,
    };
  }

  /**
   * Get all collections that need migration.
   */
  getCollectionsToMigrate(): CollectionMigrationMapping[] {
    return getUnmigratedMappings(this.state);
  }

  /**
   * Record a completed migration.
   */
  recordMigration(oldName: string): void {
    this.state = markMigrationComplete(this.state, oldName);
    saveMigrationState(this.state);
  }

  /**
   * Get the migration state.
   */
  getMigrationState(): CollectionMigrationState {
    return this.state;
  }

  /**
   * Reload migration state from disk.
   */
  reload(): void {
    this.state = loadMigrationState();
  }
}
