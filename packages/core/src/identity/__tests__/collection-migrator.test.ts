/**
 * Unit tests for collection name migration.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  generateLegacyCollectionName,
  generateCanonicalCollectionName,
  generateCollectionNames,
  loadMigrationState,
  saveMigrationState,
  addMigrationMapping,
  markMigrationComplete,
  findMappingByLegacyName,
  findMappingByPath,
  findMappingByCanonicalId,
  getUnmigratedMappings,
  CollectionMigrator,
  CollectionMigrationState,
} from '../collection-migrator';
import { resolveIdentity } from '../repo-identity';

// Helper to create a temporary directory
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Helper to clean up a directory
function cleanupDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup
  }
}

// Helper to run git commands (disables commit signing for test environments)
function git(cwd: string, ...args: string[]): string {
  const env = {
    ...process.env,
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
  };

  return execSync(`git -c commit.gpgsign=false -c user.name="Test User" -c user.email="test@example.com" ${args.join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  }).trim();
}

describe('generateLegacyCollectionName', () => {
  it('generates 8-char hash for hybrid collections', () => {
    const name = generateLegacyCollectionName('/test/path', true);
    expect(name).toMatch(/^hybrid_code_chunks_[a-f0-9]{8}$/);
  });

  it('generates 8-char hash for non-hybrid collections', () => {
    const name = generateLegacyCollectionName('/test/path', false);
    expect(name).toMatch(/^code_chunks_[a-f0-9]{8}$/);
  });

  it('generates different names for different paths', () => {
    const name1 = generateLegacyCollectionName('/path/one', true);
    const name2 = generateLegacyCollectionName('/path/two', true);
    expect(name1).not.toBe(name2);
  });

  it('generates same name for same path', () => {
    const name1 = generateLegacyCollectionName('/same/path', true);
    const name2 = generateLegacyCollectionName('/same/path', true);
    expect(name1).toBe(name2);
  });
});

describe('generateCanonicalCollectionName', () => {
  it('generates 12-char hash for hybrid collections', () => {
    const name = generateCanonicalCollectionName('some-canonical-id', true);
    expect(name).toMatch(/^hybrid_code_chunks_[a-f0-9]{12}$/);
  });

  it('generates 12-char hash for non-hybrid collections', () => {
    const name = generateCanonicalCollectionName('some-canonical-id', false);
    expect(name).toMatch(/^code_chunks_[a-f0-9]{12}$/);
  });

  it('generates same name for same canonical ID', () => {
    const name1 = generateCanonicalCollectionName('my-canonical-id', true);
    const name2 = generateCanonicalCollectionName('my-canonical-id', true);
    expect(name1).toBe(name2);
  });
});

describe('generateCollectionNames', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('coll-names-');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('generates both legacy and canonical names', () => {
    const { legacyName, canonicalName, identity } = generateCollectionNames(tempDir, true);

    expect(legacyName).toMatch(/^hybrid_code_chunks_[a-f0-9]{8}$/);
    expect(canonicalName).toMatch(/^hybrid_code_chunks_[a-f0-9]{12}$/);
    expect(identity).toBeDefined();
    expect(identity.canonicalId).toBeTruthy();
  });

  it('uses git identity for canonical name when available', () => {
    git(tempDir, 'init');
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');
    git(tempDir, 'add', '.');
    git(tempDir, 'commit', '-m', '"init"');
    git(tempDir, 'remote', 'add', 'origin', 'git@github.com:test/repo.git');

    const { identity, canonicalName } = generateCollectionNames(tempDir, true);

    expect(identity.remoteUrl).toBe('github.com/test/repo');
    expect(identity.identitySource).toBe('remote-url');
    expect(canonicalName).toMatch(/^hybrid_code_chunks_[a-f0-9]{12}$/);
  });
});

describe('Migration State Management', () => {
  let originalMigrationFile: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('migration-state-');
    // Save original migration file path (we're testing state management, not file I/O)
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  describe('addMigrationMapping', () => {
    it('adds a new mapping to empty state', () => {
      const state: CollectionMigrationState = {
        version: 'v1',
        mappings: [],
        lastUpdated: new Date().toISOString(),
      };

      const updated = addMigrationMapping(state, {
        oldName: 'hybrid_code_chunks_12345678',
        newName: 'hybrid_code_chunks_123456789012',
        canonicalId: 'some-id',
        path: '/test/path',
      });

      expect(updated.mappings).toHaveLength(1);
      expect(updated.mappings[0].oldName).toBe('hybrid_code_chunks_12345678');
      expect(updated.mappings[0].newName).toBe('hybrid_code_chunks_123456789012');
      expect(updated.mappings[0].migrated).toBe(false);
      expect(updated.mappings[0].createdAt).toBeTruthy();
    });

    it('updates existing mapping by old name', () => {
      const state: CollectionMigrationState = {
        version: 'v1',
        mappings: [{
          oldName: 'hybrid_code_chunks_12345678',
          newName: 'hybrid_code_chunks_old',
          canonicalId: 'old-id',
          path: '/test/path',
          createdAt: '2024-01-01',
          migrated: false,
        }],
        lastUpdated: new Date().toISOString(),
      };

      const updated = addMigrationMapping(state, {
        oldName: 'hybrid_code_chunks_12345678',
        newName: 'hybrid_code_chunks_new',
        canonicalId: 'new-id',
        path: '/test/path',
      });

      expect(updated.mappings).toHaveLength(1);
      expect(updated.mappings[0].newName).toBe('hybrid_code_chunks_new');
      expect(updated.mappings[0].canonicalId).toBe('new-id');
    });
  });

  describe('markMigrationComplete', () => {
    it('marks a mapping as migrated', () => {
      const state: CollectionMigrationState = {
        version: 'v1',
        mappings: [{
          oldName: 'hybrid_code_chunks_12345678',
          newName: 'hybrid_code_chunks_123456789012',
          canonicalId: 'some-id',
          path: '/test/path',
          createdAt: '2024-01-01',
          migrated: false,
        }],
        lastUpdated: new Date().toISOString(),
      };

      const updated = markMigrationComplete(state, 'hybrid_code_chunks_12345678');

      expect(updated.mappings[0].migrated).toBe(true);
      expect(updated.mappings[0].migratedAt).toBeTruthy();
    });
  });

  describe('findMappingByLegacyName', () => {
    it('finds mapping by legacy name', () => {
      const state: CollectionMigrationState = {
        version: 'v1',
        mappings: [{
          oldName: 'hybrid_code_chunks_12345678',
          newName: 'hybrid_code_chunks_123456789012',
          canonicalId: 'some-id',
          path: '/test/path',
          createdAt: '2024-01-01',
          migrated: false,
        }],
        lastUpdated: new Date().toISOString(),
      };

      const mapping = findMappingByLegacyName(state, 'hybrid_code_chunks_12345678');
      expect(mapping).toBeDefined();
      expect(mapping?.canonicalId).toBe('some-id');
    });

    it('returns undefined for non-existent legacy name', () => {
      const state: CollectionMigrationState = {
        version: 'v1',
        mappings: [],
        lastUpdated: new Date().toISOString(),
      };

      const mapping = findMappingByLegacyName(state, 'non-existent');
      expect(mapping).toBeUndefined();
    });
  });

  describe('getUnmigratedMappings', () => {
    it('returns only unmigrated mappings', () => {
      const state: CollectionMigrationState = {
        version: 'v1',
        mappings: [
          {
            oldName: 'old1',
            newName: 'new1',
            canonicalId: 'id1',
            path: '/path1',
            createdAt: '2024-01-01',
            migrated: false,
          },
          {
            oldName: 'old2',
            newName: 'new2',
            canonicalId: 'id2',
            path: '/path2',
            createdAt: '2024-01-01',
            migrated: true,
            migratedAt: '2024-01-02',
          },
          {
            oldName: 'old3',
            newName: 'new3',
            canonicalId: 'id3',
            path: '/path3',
            createdAt: '2024-01-01',
            migrated: false,
          },
        ],
        lastUpdated: new Date().toISOString(),
      };

      const unmigrated = getUnmigratedMappings(state);
      expect(unmigrated).toHaveLength(2);
      expect(unmigrated.map(m => m.oldName)).toEqual(['old1', 'old3']);
    });
  });
});

describe('CollectionMigrator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('migrator-');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  describe('resolveCollectionName', () => {
    it('returns canonical name when no existing collections', () => {
      const migrator = new CollectionMigrator();
      migrator.setExistingCollections([]);

      const result = migrator.resolveCollectionName(tempDir, true);

      expect(result.collectionName).toMatch(/^hybrid_code_chunks_[a-f0-9]{12}$/);
      expect(result.isLegacy).toBe(false);
    });

    it('returns legacy name when legacy collection exists', () => {
      const migrator = new CollectionMigrator();

      // Generate the legacy name that would be created for this path
      const legacyName = generateLegacyCollectionName(tempDir, true);
      migrator.setExistingCollections([legacyName]);

      const result = migrator.resolveCollectionName(tempDir, true);

      expect(result.collectionName).toBe(legacyName);
      expect(result.isLegacy).toBe(true);
      expect(result.legacyName).toBe(legacyName);
      expect(result.canonicalName).toMatch(/^hybrid_code_chunks_[a-f0-9]{12}$/);
    });

    it('returns canonical name when canonical collection exists', () => {
      const migrator = new CollectionMigrator();

      // Get the expected canonical name
      const { canonicalName } = generateCollectionNames(tempDir, true);
      migrator.setExistingCollections([canonicalName]);

      const result = migrator.resolveCollectionName(tempDir, true);

      expect(result.collectionName).toBe(canonicalName);
      expect(result.isLegacy).toBe(false);
    });

    it('prefers legacy collection when both exist', () => {
      const migrator = new CollectionMigrator();

      const legacyName = generateLegacyCollectionName(tempDir, true);
      const { canonicalName } = generateCollectionNames(tempDir, true);
      migrator.setExistingCollections([legacyName, canonicalName]);

      const result = migrator.resolveCollectionName(tempDir, true);

      // Should prefer legacy for backward compatibility
      expect(result.collectionName).toBe(legacyName);
      expect(result.isLegacy).toBe(true);
    });
  });

  describe('collection tracking', () => {
    it('tracks new collections', () => {
      const migrator = new CollectionMigrator();
      migrator.setExistingCollections([]);

      expect(migrator.hasCollection('new_collection')).toBe(false);

      migrator.addCollection('new_collection');

      expect(migrator.hasCollection('new_collection')).toBe(true);
    });

    it('removes dropped collections', () => {
      const migrator = new CollectionMigrator();
      migrator.setExistingCollections(['existing_collection']);

      expect(migrator.hasCollection('existing_collection')).toBe(true);

      migrator.removeCollection('existing_collection');

      expect(migrator.hasCollection('existing_collection')).toBe(false);
    });
  });

  describe('worktree handling', () => {
    it('returns same collection name for main repo and worktree', () => {
      // Create main repo
      git(tempDir, 'init');
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');
      git(tempDir, 'add', '.');
      git(tempDir, 'commit', '-m', '"init"');
      git(tempDir, 'remote', 'add', 'origin', 'git@github.com:test/worktree-test.git');

      // Create worktree
      const worktreeDir = createTempDir('worktree-');
      cleanupDir(worktreeDir);

      try {
        git(tempDir, 'worktree', 'add', worktreeDir, '-b', 'feature');

        const migrator = new CollectionMigrator();
        migrator.setExistingCollections([]);

        const mainResult = migrator.resolveCollectionName(tempDir, true);
        const worktreeResult = migrator.resolveCollectionName(worktreeDir, true);

        // Both should resolve to the same canonical name
        expect(mainResult.canonicalName).toBe(worktreeResult.canonicalName);
        expect(mainResult.identity?.canonicalId).toBe(worktreeResult.identity?.canonicalId);
      } finally {
        try {
          git(tempDir, 'worktree', 'remove', worktreeDir, '--force');
        } catch {
          cleanupDir(worktreeDir);
        }
      }
    });
  });
});
